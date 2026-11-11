import { TOOLS_V2 } from '../lib/tools-v2'
import { WIDGET_URI } from './widget'

// ChatGPT-facing tool definitions. Nothing here queries data: every tool maps to a v2 tool run by the
// shared runTool/V2_HANDLERS path. This file only adapts descriptions, defaults and output shape.
export const V2_LIST = 'list_business_checking' // exposed under its v2 name: the same tool on every surface
export const DEFAULT_LIMIT = 5 // one horizontally scrolling card per row
export const MAX_LIMIT = 5

// The card always needs these, whatever `fields` the model asks for (v2 `fields` replaces defaults).
export const CARD_FIELDS = [
  'institution_name', 'institution_display_name', 'product_name', 'monthly_fee',
  'minimum_opening_deposit', 'insurance_type', 'deposit_insurance_extended', 'deposit_insurance_extended_limit',
  'apy_max', 'apy_default', 'last_verified',
]
// Not on the card: gives the model something to say that the card can't. Without these it can only
// restate the card. Requested (not defaulted) so false = not offered and null = not published.
export const CONTEXT_FIELDS = [
  'free_transactions_per_month', 'per_transaction_fee_after_limit', 'cash_deposit_available',
  'cash_deposit_fee_per_100', 'monthly_cash_deposit_limit', 'outgoing_domestic_wire_fee',
  'physical_debit_card_available', 'atm_fee_reimbursement', 'accounting_integration_available',
  'target_industries', 'target_business_profiles', // lets the model say which returned accounts are tagged for the user's segment
]

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const NOAUTH = [{ type: 'noauth' }]

// Shared by every tool so the grounding rules cannot drift between them.
const GROUND =
  'GROUNDING: use ONLY values in the returned data; never state a rate, fee, limit, feature, promotion or eligibility rule that is not in it, never fill gaps from general knowledge, never mention banks that were not returned. ' +
  'An absent field means the data does not show it (not offered or not published): say so. Do not imply ranking or preference.'
const UNITS = 'Fee amounts and deposits are US dollars, never percentages; apy values are fractions (0.033 = 3.3%); a *_condition value qualifies the value next to it.'

const v2 = (name: string) => TOOLS_V2.find((t) => t.name === name)!
// Links are not shown on this surface (the answer is prose), so drop v2 text that talks about them.
const noLinks = (t: string) => t.replace(/ with application_url/g, '').replace(/\s*Give application_url[^.]*\./g, '')

const SEARCH_TEXT =
  'Search US business checking accounts by the customer\'s needs. The user sees a horizontally scrolling card for each returned row (name, fee, opening deposit, APY, insurance, Learn More button); you receive the same rows (up to ' + MAX_LIMIT + '). Tapping Learn More on a card sends you a message asking about that account. ' +
  'RESPONSE STYLE: never list or restate the cards, and never write or repeat application_url or any link. ' +
  'Write 2-4 sentences of analysis the cards cannot give: what actually separates these options in the returned fields (e.g. which pay APY and what unlocks it, extended deposit insurance, cash-deposit limits or fees, transaction limits, integrations), naming a bank only where a difference matters (never call any result top, best or leading). ' +
  'If the user stated their circumstances (entity type, state, industry, cash use, balance, priorities), say which results fit best and why in terms of those circumstances, citing the fields. ' +
  'When the ask is about who an account is built for (content creator, ecommerce seller, restaurant, startup, side hustle...), pass the matching rank_industries / rank_profiles values: they rank and never exclude, and an explicit sort comes first, so omit sort for a fit ask. Then say which returned accounts are tagged for that segment (target_industries / target_business_profiles) and which are not. ' +
  GROUND + ' If nothing matches, say so and suggest loosening filters. ' +
  'Units: when you mention a fee, deposit or APY, quote the row\'s monthly_fee_display / minimum_opening_deposit_display / apy_display / insurance_display strings. ' + UNITS + ' ' +
  '`fields` takes database column names only: the *_display strings are always included, and filter parameters (integrations_any, integrations_all, ...) are never fields. ' +
  'When the user asks to learn more about an account, call get_listing with that account\'s listing_slug in slugs; for a free-text lookup of a fee or feature across banks call search_facts; to compare specific fees across banks call fees_by_type. ' +
  'Omit `limit` unless the user asks for fewer results (default ' + DEFAULT_LIMIT + ', max ' + MAX_LIMIT + '); use next_offset as offset if they ask for more.'

const listBase = v2(V2_LIST)
const LIST_TOOL = {
  name: V2_LIST,
  title: 'Search business checking accounts',
  description: SEARCH_TEXT,
  inputSchema: {
    ...listBase.inputSchema,
    properties: {
      ...listBase.inputSchema.properties,
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Rows per page. Omit unless the user asks for fewer (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
    },
  },
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
  annotations: ANNOTATIONS,
  _meta: {
    ui: { resourceUri: WIDGET_URI },
    'openai/outputTemplate': WIDGET_URI,
    'openai/toolInvocation/invoking': 'Searching business checking accounts',
    'openai/toolInvocation/invoked': 'Found business checking accounts',
    securitySchemes: NOAUTH,
  },
}

// v2 tools passed through with their v2 input schema; `key` is the array in the result that holds the data.
type DataTool = {
  title: string
  busy: [string, string]
  intro?: string // replaces the v2 description when it needs ChatGPT-specific wording
  style: string
  key: string
  defaults?: Record<string, unknown> // applied when the model omits the argument
  empty?: string // error returned when `key` comes back empty
  patch?: (schema: Json) => Json
}
type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

const SECTIONS = ['summary', 'tiers', 'fees', 'features', 'promotions']

// Active business checking listing_slugs, shown to the model so a bank the user names cold can be fetched
// without a list call first. A plain list in a description, not a schema enum: an enum is enforced by
// validateArgs, so a listing missing here would be unreachable. integration/chatgpt-listing-slugs fails when
// this list and the database differ, so adding a listing means updating it here too.
export const LISTING_SLUGS = [
  'bluevine-business-checking', 'citibank-streamlined-checking', 'found-online-business-checking',
  'grasshopper-small-business-checking', 'highbeam-business-checking', 'jpmorgan-chase-bank-business-complete-checking',
  'karat-business-checking', 'lili-business-checking', 'mercury-business-banking', 'novo-business-checking',
  'ramp-business-checking', 'relay-business-checking', 'rho-business-checking',
]

const slugsDesc = (s: Json, describe: (v2: string) => string): Json => ({
  ...s,
  properties: { ...s.properties, slugs: { ...s.properties.slugs, description: describe(s.properties.slugs.description) } },
})
const sameSlugs = (v2: string) => `${v2} (same listing_slugs as get_listing)`

export const DATA_TOOLS: Record<string, DataTool> = {
  get_listing: {
    title: 'Business checking account details',
    busy: ['Getting account details', 'Got account details'],
    intro:
      'Full details (fees, features, plan tiers, promotions) for 1-4 business checking accounts by listing_slug from list_business_checking rows. For "learn more" about one account (for example after the user taps Learn More on a card) pass its single slug; to compare accounts the user named, pass up to 4.',
    style:
      'RESPONSE STYLE: explain why this account would or would not suit THIS user\'s situation (entity type, state, industry, cash use, balance and priorities they stated earlier in the chat), tying specific fees, features, promotions and tiers from the returned data to that situation; lead with the fit, then the key costs and conditions. When comparing, say which fits their situation better and why. Be concrete, not a brochure, and never write any link. If their situation is unknown, say what the account suits and where it is weak, then ask what matters to them.',
    key: 'listings',
    defaults: { sections: SECTIONS },
    empty: 'No active listing found for those listing_slugs. Use listing_slugs from list_business_checking.',
    patch: (s) => {
      const t = slugsDesc(s, () => `1-4 listing_slugs. Known: ${LISTING_SLUGS.join(', ')}. For any other bank call list_business_checking and read its rows or matches_overview.`)
      return { ...t, properties: { ...t.properties, sections: { ...t.properties.sections, description: 'summary, tiers, fees, features, promotions. Omit for all five' } } }
    },
  },
  search_facts: {
    title: 'Search fee and feature details',
    busy: ['Searching fee and feature details', 'Found fee and feature details'],
    style:
      'RESPONSE STYLE: answer the user\'s actual ask from the returned snippets, naming each bank and the plan a fact applies to, with its as_of date when shown; quote amounts exactly as the snippet states them; if no bank matched, say so instead of guessing; never write any link.',
    key: 'hits',
    patch: (s) => slugsDesc(s, sameSlugs),
  },
  fees_by_type: {
    title: 'Compare fees across banks',
    busy: ['Comparing fees', 'Compared fees'],
    style:
      'RESPONSE STYLE: compare the requested fee across the returned banks (amount, unit, allowance, waiver conditions, plan), say which plan each row applies to, and say plainly where a bank has no row for that fee (not published); never write any link.',
    key: 'results', // v2 returns a bare array; see shapeData
    patch: (s) => slugsDesc(s, sameSlugs),
  },
}

function dataToolDescriptor(name: string, d: DataTool) {
  const t = v2(name)
  return {
    name,
    title: d.title,
    description: [d.intro ?? noLinks(t.description), d.style, GROUND, 'Units: ' + UNITS].join(' '),
    inputSchema: d.patch ? d.patch(t.inputSchema) : t.inputSchema,
    outputSchema: { type: 'object', properties: { [d.key]: { type: 'array', items: { type: 'object' } } }, required: [d.key], additionalProperties: true },
    annotations: ANNOTATIONS,
    // Data tools have no widget template: the model writes the answer.
    _meta: { 'openai/toolInvocation/invoking': d.busy[0], 'openai/toolInvocation/invoked': d.busy[1], securitySchemes: NOAUTH },
  }
}

export const TOOL_LIST = [LIST_TOOL, ...Object.entries(DATA_TOOLS).map(([n, d]) => dataToolDescriptor(n, d))]

const stripLinks = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(stripLinks)
  : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'application_url').map(([k, v]) => [k, stripLinks(v)]))
  : x

// structuredContent must be an object (fees_by_type returns a bare array) and carries no links.
export const shapeData = (results: object): Record<string, unknown> =>
  stripLinks(Array.isArray(results) ? { results } : results) as Record<string, unknown>

// v2 rejects the whole call on one unknown `fields` name and the message lists every offender.
export function unknownFieldNames(message: string): string[] {
  const m = /^Unknown field: ([^.]+)\./.exec(message)
  return m ? m[1]!.split(',').map((s) => s.trim()).filter(Boolean) : []
}
