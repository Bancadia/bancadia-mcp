import { Hono } from 'hono'
import type { Env } from '../types'
import { TOOLS_V2 } from '../lib/tools-v2'
import { runTool } from '../lib/run-tool'
import { rateLimit } from '../lib/rate-limit'
import { validateOrigin } from '../lib/origin'
import type { QueryMeta } from '../lib/analytics'
import { WIDGET_URI, WIDGET_MIME, WIDGET_HTML } from './widget'

// ChatGPT App surface: stateless MCP over plain JSON (no Mcp-Session-Id), noauth,
// read-only. Reuses the v2 list handler via runTool, so query logic is not duplicated.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const TOOL_NAME = 'search_business_checking'
const V2_NAME = 'list_business_checking'
const DEFAULT_LIMIT = 4
const MAX_LIMIT = 8
// The card always needs these, whatever `fields` the model asks for (v2 `fields` replaces defaults).
const CARD_FIELDS = [
  'institution_name', 'institution_display_name', 'product_name', 'monthly_fee',
  'minimum_opening_deposit', 'insurance_type', 'apy_max', 'last_verified',
]

const GROUNDING =
  'Search US business checking accounts by the customer\'s needs. A card carousel of the results is shown to the user, so do NOT restate the table. ' +
  'Instead, explain briefly why each recommended bank fits THIS customer\'s stated circumstances, citing the specific returned fields that support it, plus the main trade-off. ' +
  'Use ONLY values in the returned data: never state a rate, fee, limit, feature, promotion or eligibility rule that is not in it, never fill gaps from general knowledge, and never mention banks that were not returned. ' +
  'An absent field means the data does not show it (not offered or not published): say so. If nothing matches, say so and suggest loosening filters. ' +
  'Do not imply ranking or preference among banks. Give application_url to the user exactly as returned. Returns up to `limit` rows (default 4, max 8); use next_offset as offset for more.'

const base = TOOLS_V2.find((t) => t.name === V2_NAME)!
const inputSchema = {
  ...base.inputSchema,
  properties: {
    ...base.inputSchema.properties,
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Rows per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
  },
}

const TOOL = {
  name: TOOL_NAME,
  title: 'Search business checking accounts',
  description: GROUNDING,
  inputSchema,
  outputSchema: {
    type: 'object',
    properties: {
      total_matches: { type: 'integer' },
      returned: { type: 'integer' },
      next_offset: { type: ['integer', 'null'] },
      rows: { type: 'array', items: { type: 'object' } },
    },
    required: ['rows'],
    additionalProperties: true,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: {
    ui: { resourceUri: WIDGET_URI },
    'openai/outputTemplate': WIDGET_URI,
    'openai/toolInvocation/invoking': 'Searching business checking accounts',
    'openai/toolInvocation/invoked': 'Found business checking accounts',
    securitySchemes: [{ type: 'noauth' }],
  },
}

type Rpc = { jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }

const chatgpt = new Hono<{ Bindings: Env }>()

chatgpt.post('/mcp', async (c) => {
  if (!validateOrigin(c.req.raw, c.env)) return c.text('Forbidden', 403)

  let body: Rpc
  try {
    body = await c.req.json<Rpc>()
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }
  const { id, method, params = {} } = body
  if (id === undefined) return c.body(null, 202) // notification
  const ok = (result: unknown) => c.json({ jsonrpc: '2.0', id, result })
  const err = (code: number, message: string, status: 200 | 400 | 404 | 429 = 200) =>
    c.json({ jsonrpc: '2.0', id, error: { code, message } }, status)

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion as string | undefined
      return ok({
        protocolVersion: requested && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'Bancadia', version: '0.1.0' },
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: [TOOL] })
    case 'resources/list':
      return ok({ resources: [{ uri: WIDGET_URI, name: 'Business checking results', mimeType: WIDGET_MIME }] })
    case 'resources/read': {
      if (params.uri !== WIDGET_URI) return err(-32002, `Resource not found: ${String(params.uri)}`)
      return ok({
        contents: [{
          uri: WIDGET_URI,
          mimeType: WIDGET_MIME,
          text: WIDGET_HTML,
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
        }],
      })
    }
    case 'tools/call': {
      if (params.name !== TOOL_NAME) return err(-32601, `Unknown tool: ${String(params.name)}`, 404)

      // shortcut: ChatGPT calls arrive from shared OpenAI IPs, so a per-IP key is effectively one global bucket; revisit before launch.
      const rl = await rateLimit(c.env, `chatgpt:ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, 'developer')
      if (!rl.success) return err(-32029, 'Rate limit exceeded.', 429)

      const args = { ...((params.arguments as Record<string, unknown>) ?? {}) }
      args.limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      args.fields = [...new Set([...CARD_FIELDS, ...((args.fields as string[] | undefined) ?? [])])]

      const meta: QueryMeta = {
        toolName: V2_NAME,
        developerId: null,
        channel: 'chatgpt',
        sessionId: null,
        userAgent: c.req.header('User-Agent') ?? null,
        requestId: crypto.randomUUID(),
      }
      const r = await runTool(V2_NAME, args, meta, c.env, c.executionCtx)
      if (r.status !== 'ok') {
        const text = r.status === 'invalid_args' ? r.message : 'Internal error while querying listings. Please retry.'
        return ok({ isError: true, content: [{ type: 'text', text }] })
      }
      // `hint` points at v2 tools this surface does not expose.
      const { hint: _hint, ...structured } = r.results as Record<string, unknown>
      const n = (structured.rows as unknown[]).length
      return ok({
        structuredContent: structured,
        content: [{
          type: 'text',
          text: `${n} of ${String(structured.total_matches)} matching accounts shown as cards. Explain why each fits the customer using only fields in structuredContent; do not restate the table or add facts not in the data.`,
        }],
      })
    }
    default:
      return err(-32601, `Method not found: ${method}`, 404)
  }
})

chatgpt.get('/mcp', (c) => c.text('Method Not Allowed', 405))

export default chatgpt
