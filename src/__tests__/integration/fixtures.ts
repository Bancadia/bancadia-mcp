// Known-stable identifiers into bancadia-db's onboarding-scripts seed data
// (supabase/onboarding-scripts/, applied automatically by `supabase db
// reset --local` via config.toml's [db.seed] sql_paths). `listing_slug` is
// the only stable identifier across `supabase db reset --local` runs --
// `id`/`institution_id` are `gen_random_uuid()` in those scripts and
// regenerate every reset. Never hardcode a UUID for this data; resolve it
// at test-run time via db-helpers.ts's lookupListingIdBySlug().
//
// Values below were read directly from the seeded local database (not
// hand-transcribed from the SQL) via a one-off query against all 11 active
// checking listings as of 2026-08-17 -- re-verify by querying if an
// onboarding script changes.
export const KNOWN_SLUGS = {
  mercury: 'mercury-business-banking',
  bluevine: 'bluevine-business-checking',
  novo: 'novo-business-checking',
  chase: 'jpmorgan-chase-bank-business-complete-checking',
  citibank: 'citibank-streamlined-checking',
  found: 'found-online-business-checking',
  grasshopper: 'grasshopper-small-business-checking',
  lili: 'lili-business-checking',
  ramp: 'ramp-business-checking',
  relay: 'relay-business-checking',
  rho: 'rho-business-checking',
} as const

export const ALL_KNOWN_SLUGS: string[] = Object.values(KNOWN_SLUGS)

// business_checking_details.apy_default / apy_max for every interest-bearing
// listing, read from the seeded local database (bancadia-db migration 052's
// backfill). Stored as decimals (0.03 = 3%). The other 8 checking listings
// are interest_bearing = false and have NULL for both -- including
// karat-business-checking since bancadia-db migration 059 (single plan,
// checking earns 0.00%; its 1.00% ATP rate is an account feature, not
// checking APY). Deliberately chosen so apy_default and apy_max diverge for
// found/bluevine -- that's what lets a test tell "filters on apy_max" apart
// from "filters on apy_default".
export const APY_EXPECTED = {
  'highbeam-business-checking': { apy_default: 0, apy_max: 0.0132 },
  [KNOWN_SLUGS.grasshopper]: { apy_default: 0.01, apy_max: 0.0135 },
  [KNOWN_SLUGS.ramp]: { apy_default: 0.02, apy_max: 0.02 },
  [KNOWN_SLUGS.found]: { apy_default: 0, apy_max: 0.025 },
  [KNOWN_SLUGS.bluevine]: { apy_default: 0.013, apy_max: 0.033 },
} as const

export const APY_SLUGS: string[] = Object.keys(APY_EXPECTED)

type ExpectedListing = {
  monthly_fee: number
  rtp_supported: boolean
  entity_types_accepted: string[]
}

export const EXPECTED: Record<string, ExpectedListing> = {
  [KNOWN_SLUGS.mercury]: {
    monthly_fee: 0,
    rtp_supported: true, // rtp_network 'both' since migration 071
    // No sole_prop -- the fixture for entity_types_accepted exclusion tests.
    entity_types_accepted: ['llc', 's_corp', 'c_corp', 'partnership'],
  },
  [KNOWN_SLUGS.bluevine]: {
    monthly_fee: 0,
    rtp_supported: false,
    entity_types_accepted: ['sole_prop', 'partnership', 'llc', 'c_corp', 's_corp', 'nonprofit'],
  },
  [KNOWN_SLUGS.novo]: {
    monthly_fee: 0,
    rtp_supported: false,
    // All 6 entity types -- the "always matches" fixture.
    entity_types_accepted: ['sole_prop', 'llc', 's_corp', 'c_corp', 'partnership', 'nonprofit'],
  },
  [KNOWN_SLUGS.chase]: {
    // The only two listings (with citibank) at monthly_fee=15; everything
    // else in the known set is 0 -- the fixture for monthly_fee_max tests.
    monthly_fee: 15,
    rtp_supported: true,
    entity_types_accepted: ['llc', 'sole_prop', 'c_corp', 's_corp', 'nonprofit'],
  },
} as const

// Exact expected slug sets (scoped to ALL_KNOWN_SLUGS) per REST filter case, read from the seeded local
// database (bancadia-db onboarding scripts). Order is not asserted here: ties on monthly_fee break by
// random listing id, so set equality is the stable expectation; ordering is covered by REST/MCP parity.
const K = KNOWN_SLUGS
export const REST_FILTER_CASES: Array<{ name: string; query: string; mcp: Record<string, unknown>; slugs: string[] }> = [
  { name: 'no params', query: '', mcp: {}, slugs: ALL_KNOWN_SLUGS },
  { name: 'monthly_fee_max=0', query: 'monthly_fee_max=0', mcp: { monthly_fee_max: 0 },
    slugs: [K.mercury, K.bluevine, K.novo, K.found, K.grasshopper, K.lili, K.ramp, K.relay, K.rho] },
  { name: 'minimum_opening_deposit_max=0', query: 'minimum_opening_deposit_max=0', mcp: { minimum_opening_deposit_max: 0 },
    slugs: ALL_KNOWN_SLUGS.filter((s) => s !== K.citibank && s !== K.grasshopper) },
  { name: 'entity_types_accepted=sole_prop', query: 'entity_types_accepted=sole_prop', mcp: { entity_types_accepted: ['sole_prop'] },
    slugs: ALL_KNOWN_SLUGS.filter((s) => s !== K.mercury && s !== K.rho && s !== K.ramp) },
  { name: 'entity_types_accepted=sole_prop,nonprofit (all-of)', query: 'entity_types_accepted=sole_prop,nonprofit',
    mcp: { entity_types_accepted: ['sole_prop', 'nonprofit'] }, slugs: [K.bluevine, K.chase, K.citibank, K.found, K.lili, K.novo, K.relay] },
  { name: 'insurance_type=fdic', query: 'insurance_type=fdic', mcp: { insurance_type: 'fdic' }, slugs: ALL_KNOWN_SLUGS },
  { name: 'insurance_type=ncua', query: 'insurance_type=ncua', mcp: { insurance_type: 'ncua' }, slugs: [] },
  { name: 'accounting_integration_available=true', query: 'accounting_integration_available=true', mcp: { accounting_integration_available: true },
    slugs: ALL_KNOWN_SLUGS.filter((s) => s !== K.citibank && s !== K.chase) },
  { name: 'interest_bearing=true', query: 'interest_bearing=true', mcp: { interest_bearing: true }, slugs: [K.bluevine, K.found, K.grasshopper, K.ramp] },
  { name: 'sub_accounts_supported=true', query: 'sub_accounts_supported=true', mcp: { sub_accounts_supported: true },
    slugs: [K.bluevine, K.found, K.mercury, K.ramp, K.relay, K.rho] },
  { name: 'cash_deposit_available=true', query: 'cash_deposit_available=true', mcp: { cash_deposit_available: true },
    slugs: [K.bluevine, K.citibank, K.found, K.chase, K.lili, K.relay] },
  { name: 'free_transactions_min=20', query: 'free_transactions_min=20', mcp: { free_transactions_min: 20 }, slugs: [K.citibank, K.chase] },
  { name: 'apy_min=0.02', query: 'apy_min=0.02', mcp: { apy_min: 0.02 }, slugs: [K.ramp, K.found, K.bluevine] },
  { name: 'rtp_network=fednow', query: 'rtp_network=fednow', mcp: { rtp_network: 'fednow' }, slugs: [K.found, K.grasshopper] },
  { name: 'rtp_network=both', query: 'rtp_network=both', mcp: { rtp_network: 'both' }, slugs: [K.chase, K.mercury] },
  { name: 'combo: fee 0 + interest_bearing + nonprofit', query: 'monthly_fee_max=0&interest_bearing=true&entity_types_accepted=nonprofit',
    mcp: { monthly_fee_max: 0, interest_bearing: true, entity_types_accepted: ['nonprofit'] }, slugs: [K.bluevine, K.found, K.ramp] },
  { name: 'matches nothing', query: 'monthly_fee_max=0&rtp_network=both', mcp: { monthly_fee_max: 0, rtp_network: 'both' }, slugs: [K.mercury] },
]
