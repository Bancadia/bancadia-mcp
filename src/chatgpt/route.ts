import { Hono } from 'hono'
import type { Env } from '../types'
import { TOOLS_V2 } from '../lib/tools-v2'
import { runTool } from '../lib/run-tool'
import { rateLimit } from '../lib/rate-limit'
import { validateOrigin } from '../lib/origin'
import type { QueryMeta } from '../lib/analytics'
import { WIDGET_URI, WIDGET_MIME, WIDGET_HTML, CARDS_SHOWN } from './widget'
import { presentRow } from './present'

// ChatGPT App surface: stateless MCP over plain JSON (no Mcp-Session-Id), noauth,
// read-only. Reuses the v2 list handler via runTool, so query logic is not duplicated.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const TOOL_NAME = 'search_business_checking'
const V2_NAME = 'list_business_checking'
const DEFAULT_LIMIT = 8 // cards show CARDS_SHOWN; the writeup covers the remaining rows
const MAX_LIMIT = 8
// The card always needs these, whatever `fields` the model asks for (v2 `fields` replaces defaults).
const CARD_FIELDS = [
  'institution_name', 'institution_display_name', 'product_name', 'monthly_fee',
  'minimum_opening_deposit', 'insurance_type', 'deposit_insurance_extended', 'deposit_insurance_extended_limit',
  'apy_max', 'apy_default', 'last_verified',
]
// Not on the card: gives the model something to say that the card can't. Without these it can only
// restate the card. Requested (not defaulted) so false = not offered and null = not published.
const CONTEXT_FIELDS = [
  'free_transactions_per_month', 'per_transaction_fee_after_limit', 'cash_deposit_available',
  'cash_deposit_fee_per_100', 'monthly_cash_deposit_limit', 'outgoing_domestic_wire_fee',
  'physical_debit_card_available', 'atm_fee_reimbursement', 'accounting_integration_available',
]

const GROUNDING =
  'Search US business checking accounts by the customer\'s needs. The user sees cards (name, fee, opening deposit, APY, insurance, Apply button) for only the first ' + CARDS_SHOWN + ' returned rows; you receive every returned row (up to ' + MAX_LIMIT + '). ' +
  'RESPONSE STYLE: never list or restate the cards, and never write or repeat application_url or any link (the Apply buttons handle it). ' +
  'Write 2-4 sentences of analysis the cards cannot give: what actually separates these options in the returned fields (e.g. which pay APY and what unlocks it, extended deposit insurance, cash-deposit limits or fees, transaction limits, integrations), naming a bank only where a difference matters, and cover the rows without a card by name too when they differ (they have no card, so do not imply they matter less, and never call any result top, best or leading). ' +
  'If the user stated their circumstances (entity type, state, industry, cash use, balance, priorities), say which results fit best and why in terms of those circumstances, citing the fields. ' +
  'If they did not, do not pick a winner: end by asking up to 4 short questions about what most changes the answer (business entity type, whether they deposit cash, top priority, typical balance), each answerable with a filter of this tool, offered as choices. ' +
  'GROUNDING: use ONLY values in the returned data; never state a rate, fee, limit, feature, promotion or eligibility rule that is not in it, never fill gaps from general knowledge, never mention banks that were not returned. ' +
  'An absent field means the data does not show it (not offered or not published): say so. If nothing matches, say so and suggest loosening filters. Do not imply ranking or preference. ' +
  'Units: when you mention a fee, deposit or APY, quote the row\'s monthly_fee_display / minimum_opening_deposit_display / apy_display / insurance_display strings (monthly_fee and minimum_opening_deposit are US dollars, never percentages; apy_* are fractions, 0.033 = 3.3%). ' +
  'Omit `limit` unless the user asks for fewer or more results (default ' + DEFAULT_LIMIT + ', max ' + MAX_LIMIT + '); use next_offset as offset for more.'

const base = TOOLS_V2.find((t) => t.name === V2_NAME)!
const inputSchema = {
  ...base.inputSchema,
  properties: {
    ...base.inputSchema.properties,
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Rows per page. Omit unless the user asks for fewer or more (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
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
      args.fields = [...new Set([...CARD_FIELDS, ...CONTEXT_FIELDS, ...((args.fields as string[] | undefined) ?? [])])]

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
      const { hint: _hint, ...rest } = r.results as Record<string, unknown>
      const structured: Record<string, unknown> & { rows: Record<string, unknown>[] } = {
        ...rest,
        rows: (rest.rows as Record<string, unknown>[]).map(presentRow),
      }
      const n = structured.rows.length
      return ok({
        structuredContent: structured,
        content: [{
          type: 'text',
          text: `${n} of ${String(structured.total_matches)} matching accounts shown as cards. Do not list or restate the cards or write any links. Add analysis of what separates the options, using only fields in structuredContent; if the customer's circumstances are unknown, ask up to 4 narrowing questions instead of picking a winner.`,
        }],
      })
    }
    default:
      return err(-32601, `Method not found: ${method}`, 404)
  }
})

chatgpt.get('/mcp', (c) => c.text('Method Not Allowed', 405))

export default chatgpt
