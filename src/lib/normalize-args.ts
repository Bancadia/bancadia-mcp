const LOWER_STRING = ['insurance_type', 'rtp_network', 'sort', 'topic']
const LOWER_ARRAY = [
  'entity_types_accepted', 'integrations_any', 'integrations_all', 'rank_industries', 'rank_profiles',
  'fields', 'fee_types', 'sections', 'slugs',
]
const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR', 'VI', 'GU', 'AS', 'MP',
]

const mapStrings = (v: unknown, f: (s: string) => string) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? f(x) : x)) : v)
const lower = (s: string) => s.trim().toLowerCase()

// Pure; run after validateArgs. Returns a new object.
export function normalizeArgs(_tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args }
  for (const k of LOWER_STRING) if (typeof out[k] === 'string') out[k] = lower(out[k] as string)
  for (const k of LOWER_ARRAY) if (k in out) out[k] = mapStrings(out[k], lower)
  if ('available_states' in out) out.available_states = mapStrings(out.available_states, (s) => s.trim().toUpperCase())
  if (typeof out.plan === 'string') out.plan = out.plan.trim()
  const ml = out.min_limits
  if (ml && typeof ml === 'object' && !Array.isArray(ml))
    out.min_limits = Object.fromEntries(Object.entries(ml).map(([k, v]) => [lower(k), v]))
  return out
}

// The DB accepts any state string; reject unknown ones here. Expects normalized (upper-cased) args.
export function validateStates(args: Record<string, unknown>): string | null {
  const bad = Array.isArray(args.available_states)
    ? args.available_states.find((s) => typeof s === 'string' && s !== 'ALL' && !STATES.includes(s))
    : undefined
  return bad === undefined ? null : `Unknown state: ${bad}. Valid states: ${STATES.join(', ')}`
}
