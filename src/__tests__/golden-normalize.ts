// Shared by scripts/capture-goldens.capture.ts and the legacy-profile byte-identity tests.
// Normalizes what legitimately varies between `supabase db reset` runs of the same seed:
// timestamps (default now()), the per-call `qr` request id, and the order of arrays
// (ties break on random uuids). Everything else must match the golden byte for byte.
export const CANNED_LIST_QUERIES: Record<string, Record<string, unknown>> = {
  all: {},
  fee0: { monthly_fee_max: 0 },
  sole_prop: { entity_types_accepted: ['sole_prop'] },
  state_ny: { available_states: ['NY'] },
  accounting: { accounting_integration_available: true },
  apy_002: { apy_min: 0.02 },
  rtp_both: { rtp_network: 'both' },
  rank_ecommerce: { target_industries: ['ecommerce'], target_business_profiles: ['early_stage_startup'] },
  nothing: { monthly_fee_max: -1 },
}
export const CANNED_GET_SLUGS = [
  'found-online-business-checking',
  'jpmorgan-chase-bank-business-complete-checking',
  'lili-business-checking',
  'mercury-business-banking',
  'no-such-listing',
]

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/
const norm = (v: unknown): unknown => {
  if (typeof v === 'string') {
    if (TS.test(v)) return '<ts>'
    return v.replace(/([?&]qr=)[0-9a-f-]{36}/, '$1<qr>')
  }
  if (Array.isArray(v)) {
    const items = v.map(norm)
    return items.some((i) => typeof i === 'object' && i !== null)
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, norm(x)]))
  }
  return v
}
export const normalizeForGolden = (rows: unknown): unknown => norm(rows)
