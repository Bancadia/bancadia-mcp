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
// backfill). Stored as decimals (0.03 = 3%). The other 7 checking listings
// are interest_bearing = false and have NULL for both. Deliberately chosen so
// apy_default and apy_max diverge for found/bluevine/karat -- that's what lets
// a test tell "filters on apy_max" apart from "filters on apy_default".
export const APY_EXPECTED = {
  'highbeam-business-checking': { apy_default: 0, apy_max: 0.0132 },
  [KNOWN_SLUGS.grasshopper]: { apy_default: 0.01, apy_max: 0.0135 },
  'karat-business-checking': { apy_default: 0, apy_max: 0.0175 },
  [KNOWN_SLUGS.ramp]: { apy_default: 0.02, apy_max: 0.02 },
  [KNOWN_SLUGS.found]: { apy_default: 0, apy_max: 0.025 },
  [KNOWN_SLUGS.bluevine]: { apy_default: 0.013, apy_max: 0.03 },
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
    rtp_supported: false,
    // No sole_prop -- the fixture for entity_types_accepted exclusion tests.
    entity_types_accepted: ['llc', 's_corp', 'c_corp', 'partnership'],
  },
  [KNOWN_SLUGS.bluevine]: {
    monthly_fee: 0,
    rtp_supported: false,
    entity_types_accepted: ['sole_prop', 'partnership', 'llc', 'c_corp', 's_corp'],
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
    entity_types_accepted: ['llc', 'sole_prop', 'c_corp', 's_corp'],
  },
} as const
