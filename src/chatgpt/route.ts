import { Hono } from 'hono'
import type { Env } from '../types'
import { TOOLS_V2 } from '../lib/tools-v2'
import { runTool } from '../lib/run-tool'
import { rateLimit } from '../lib/rate-limit'
import { validateOrigin } from '../lib/origin'
import type { QueryMeta } from '../lib/analytics'
import { WIDGET_URI, WIDGET_MIME, WIDGET_HTML } from './widget'
import { presentRow } from './present'

// ChatGPT App surface: stateless MCP over plain JSON (no Mcp-Session-Id), noauth,
// read-only. Reuses the v2 list handler via runTool, so query logic is not duplicated.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const TOOL_NAME = 'search_business_checking'
const V2_NAME = 'list_business_checking'
const DETAILS_NAME = 'get_listing' // v2 tool exposed as-is: only two descriptions, the default sections and the link strip differ
const DETAILS_SECTIONS = ['summary', 'tiers', 'fees', 'features', 'promotions']
const DEFAULT_LIMIT = 5 // one horizontally scrolling card per row
const MAX_LIMIT = 5
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
  'Search US business checking accounts by the customer\'s needs. The user sees a horizontally scrolling card for each returned row (name, fee, opening deposit, APY, insurance, Learn More button); you receive the same rows (up to ' + MAX_LIMIT + '). Tapping Learn More on a card sends you a message asking about that account. ' +
  'RESPONSE STYLE: never list or restate the cards, and never write or repeat application_url or any link. ' +
  'Write 2-4 sentences of analysis the cards cannot give: what actually separates these options in the returned fields (e.g. which pay APY and what unlocks it, extended deposit insurance, cash-deposit limits or fees, transaction limits, integrations), naming a bank only where a difference matters (never call any result top, best or leading). ' +
  'If the user stated their circumstances (entity type, state, industry, cash use, balance, priorities), say which results fit best and why in terms of those circumstances, citing the fields. ' +
  'GROUNDING: use ONLY values in the returned data; never state a rate, fee, limit, feature, promotion or eligibility rule that is not in it, never fill gaps from general knowledge, never mention banks that were not returned. ' +
  'An absent field means the data does not show it (not offered or not published): say so. If nothing matches, say so and suggest loosening filters. Do not imply ranking or preference. ' +
  'Units: when you mention a fee, deposit or APY, quote the row\'s monthly_fee_display / minimum_opening_deposit_display / apy_display / insurance_display strings (monthly_fee and minimum_opening_deposit are US dollars, never percentages; apy_* are fractions, 0.033 = 3.3%). ' +
  'When the user asks to learn more about an account, call get_listing with that account\'s listing_slug in slugs. ' +
  'Omit `limit` unless the user asks for fewer results (default ' + DEFAULT_LIMIT + ', max ' + MAX_LIMIT + '); use next_offset as offset if they ask for more.'

const base = TOOLS_V2.find((t) => t.name === V2_NAME)!
const inputSchema = {
  ...base.inputSchema,
  properties: {
    ...base.inputSchema.properties,
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Rows per page. Omit unless the user asks for fewer (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
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

const DETAILS_DESC =
  'Full details (fees, features, plan tiers, promotions) for 1-4 business checking accounts by listing_slug from search_business_checking rows. For "learn more" about one account (for example after the user taps Learn More on a card) pass its single slug; to compare accounts the user named, pass up to 4. ' +
  'RESPONSE STYLE: explain why this account would or would not suit THIS user\'s situation (entity type, state, industry, cash use, balance and priorities they stated earlier in the chat), tying specific fees, features, promotions and tiers from the returned data to that situation; lead with the fit, then the key costs and conditions. When comparing, say which fits their situation better and why. Be concrete, not a brochure, and never write any link. If their situation is unknown, say what the account suits and where it is weak, then ask what matters to them. ' +
  'GROUNDING: use ONLY values in the returned data; never state a fee, rate, limit, feature, promotion or eligibility rule that is not in it, never fill gaps from general knowledge. An absent field means not offered or not published: say so. ' +
  'Units: fee amounts are US dollars; apy values are fractions (0.033 = 3.3%); a *_condition value qualifies the value next to it. Do not imply ranking or preference over other banks.'

const detailsBase = TOOLS_V2.find((t) => t.name === DETAILS_NAME)!
const DETAILS_TOOL = {
  name: DETAILS_NAME,
  title: 'Business checking account details',
  description: DETAILS_DESC,
  inputSchema: {
    ...detailsBase.inputSchema,
    properties: {
      ...detailsBase.inputSchema.properties,
      slugs: { ...detailsBase.inputSchema.properties.slugs, description: '1-4 listing_slugs from search_business_checking rows' },
      sections: { ...detailsBase.inputSchema.properties.sections, description: 'summary, tiers, fees, features, promotions. Omit for all five' },
    },
  },
  outputSchema: {
    type: 'object',
    properties: { listings: { type: 'array', items: { type: 'object' } }, not_found: { type: 'array', items: { type: 'string' } } },
    required: ['listings'],
    additionalProperties: true,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  // Data tool: no widget template, the model writes the answer.
  _meta: {
    'openai/toolInvocation/invoking': 'Getting account details',
    'openai/toolInvocation/invoked': 'Got account details',
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
      return ok({ tools: [TOOL, DETAILS_TOOL] })
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
      if (params.name !== TOOL_NAME && params.name !== DETAILS_NAME) return err(-32601, `Unknown tool: ${String(params.name)}`, 404)

      // shortcut: ChatGPT calls arrive from shared OpenAI IPs, so a per-IP key is effectively one global bucket; revisit before launch.
      const rl = await rateLimit(c.env, `chatgpt:ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, 'developer')
      if (!rl.success) return err(-32029, 'Rate limit exceeded.', 429)

      // ChatGPT's anonymized conversation id; links a search to the get_listing that follows it. Opaque, untrusted input: string only, capped.
      const hostMeta = (params._meta ?? {}) as Record<string, unknown>
      const session = hostMeta['openai/session']
      const chatConversationId = typeof session === 'string' && session ? session.slice(0, 200) : null
      // TEMP probe (remove once confirmed in production logs): which _meta keys and openai headers does ChatGPT really send?
      console.log('chatgpt call', JSON.stringify({ metaKeys: Object.keys(hostMeta), openaiHeaders: [...c.req.raw.headers.keys()].filter((h) => /openai/i.test(h)), hasConversationId: chatConversationId !== null }))

      const meta = (toolName: string): QueryMeta => ({
        toolName,
        developerId: null,
        channel: 'chatgpt',
        sessionId: null,
        userAgent: c.req.header('User-Agent') ?? null,
        requestId: crypto.randomUUID(),
        chatConversationId,
      })
      const fail = (text: string) => ok({ isError: true, content: [{ type: 'text', text }] })

      if (params.name === DETAILS_NAME) {
        const a = { ...((params.arguments as Record<string, unknown>) ?? {}) }
        if (a.sections === undefined) a.sections = DETAILS_SECTIONS
        const d = await runTool(DETAILS_NAME, a, meta(DETAILS_NAME), c.env, c.executionCtx)
        if (d.status !== 'ok') return fail(d.status === 'invalid_args' ? d.message : 'Internal error while loading the account. Please retry.')
        const { listings = [], not_found } = d.results as { listings?: Record<string, unknown>[]; not_found?: string[] }
        if (!listings.length) return fail('No active listing found for those listing_slugs. Use listing_slugs from search_business_checking.')
        return ok({
          // The details answer is prose from the model; no links on this surface.
          structuredContent: { listings: listings.map(({ application_url: _u, ...l }) => l), ...(not_found?.length ? { not_found } : {}) },
          content: [{
            type: 'text',
            text: "Explain why this account would or would not suit the user's situation using only fields in structuredContent. Write no links and add no facts that are not in the data.",
          }],
        })
      }

      const args = { ...((params.arguments as Record<string, unknown>) ?? {}) }
      args.limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      args.fields = [...new Set([...CARD_FIELDS, ...CONTEXT_FIELDS, ...((args.fields as string[] | undefined) ?? [])])]

      const r = await runTool(V2_NAME, args, meta(V2_NAME), c.env, c.executionCtx)
      if (r.status !== 'ok') return fail(r.status === 'invalid_args' ? r.message : 'Internal error while querying listings. Please retry.')
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
          text: `${n} of ${String(structured.total_matches)} matching accounts shown as cards. Do not list or restate the cards or write any links. Add analysis of what separates the options, using only fields in structuredContent.`,
        }],
      })
    }
    default:
      return err(-32601, `Method not found: ${method}`, 404)
  }
})

chatgpt.get('/mcp', (c) => c.text('Method Not Allowed', 405))

export default chatgpt
