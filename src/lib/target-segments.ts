import type { Database } from './database.types'

type TargetSegment = Database['public']['Enums']['target_segment_enum']

// Record, not a bare array: TS forces every key to be a real TargetSegment
// (typo or renamed DB value = compile error), and forces a description to
// exist for every value (no silently-undescribed enum value). Keys are
// hand-maintained because the industry_vertical/business_profile split only
// exists as a SQL comment in the migration, not as two separate Postgres
// enums — see the drift test in target-segments.test.ts for the guard
// against a value being added to the DB enum without being added here.
export const INDUSTRY_VERTICAL_DESCRIPTIONS: Partial<Record<TargetSegment, string>> = {
  ecommerce: 'online retail/marketplace sellers',
  retail_storefront: 'physical retail location',
  restaurant_food_service: 'restaurants, cafes, food trucks',
  content_creator_solopreneur: 'creators, influencers, freelance media',
  professional_services: 'consultants, agencies, legal/accounting firms',
  real_estate: 'agents, property managers, investors',
  healthcare_practice: 'clinics, private practices',
  construction_trades: 'contractors, tradespeople',
  trucking_logistics: 'trucking, freight, logistics',
  agriculture: 'farms, agribusiness',
  saas_tech: 'software/tech companies',
  nonprofit: 'registered nonprofit organizations',
  small_business_digital_first: 'general online/no-branch small business with no other single vertical fitting best',
}

export const BUSINESS_PROFILE_DESCRIPTIONS: Partial<Record<TargetSegment, string>> = {
  early_stage_startup: 'pre-revenue or early-revenue new company',
  vc_backed: 'has raised institutional venture funding',
  bootstrapped_solopreneur: 'self-funded, one-person or very small team, run as primary full-time work',
  established_smb: 'operating business with existing revenue/history',
  high_growth: 'rapidly scaling regardless of funding source',
  side_hustle: 'part-time/secondary business run alongside other work or a day job',
}

function buildEnumSchema(descriptions: Partial<Record<TargetSegment, string>>) {
  const values = Object.keys(descriptions) as TargetSegment[]
  return {
    enum: values,
    description: `One value from: ${values.map((v) => `${v} (${descriptions[v]})`).join(', ')}.`,
  }
}

export const TARGET_INDUSTRY_SCHEMA = buildEnumSchema(INDUSTRY_VERTICAL_DESCRIPTIONS)
export const TARGET_BUSINESS_PROFILE_SCHEMA = buildEnumSchema(BUSINESS_PROFILE_DESCRIPTIONS)

// Shared literal so every handler embedding this table stays in sync — in
// particular, never add `!inner` here: this table is one-to-many and
// non-restrictive by design (soft-ranking, not a hard filter), unlike
// business_checking_details's conditional !inner embed.
export const TARGET_SEGMENTS_EMBED = 'business_deposit_account_target_segments(*)'

type TargetSegmentRow = { category: string; segment: string }

// Buckets a listing's tagged segments into the two output facets in a single
// pass, deduping by segment along the way. Dedup doesn't rely solely on the
// DB's UNIQUE(listing_id, segment) constraint (enforced in a different repo)
// even though that constraint makes duplicates impossible via any normal
// insert path today.
export function bucketTargetSegments(rows: TargetSegmentRow[] | null | undefined) {
  const target_industries: string[] = []
  const target_business_profiles: string[] = []
  const seen = new Set<string>()
  for (const row of rows ?? []) {
    if (seen.has(row.segment)) continue
    seen.add(row.segment)
    if (row.category === 'industry_vertical') {
      target_industries.push(row.segment)
    } else if (row.category === 'business_profile') {
      target_business_profiles.push(row.segment)
    }
  }
  return { target_industries, target_business_profiles }
}

// Soft-ranking: reorders (never excludes) rows so that any-of overlap
// between a row's tagged segments and the requested ones ranks ahead of
// non-matching rows, scored by raw match count across both facets combined.
// Stable sort (guaranteed in V8/workerd) preserves the caller's existing
// order — e.g. monthly_fee ascending — within each match-count tier. No-op
// (same array, same order) when nothing was requested.
export function rankByTargetSegments<T extends { business_deposit_account_target_segments: TargetSegmentRow[] }>(
  rows: T[],
  requestedIndustries: string[],
  requestedProfiles: string[]
): T[] {
  const requestedSet = new Set([...requestedIndustries, ...requestedProfiles])
  if (requestedSet.size === 0) return rows

  const matchCount = (row: T) => {
    const rowSegments = new Set((row.business_deposit_account_target_segments ?? []).map((s) => s.segment))
    let count = 0
    for (const segment of rowSegments) {
      if (requestedSet.has(segment)) count++
    }
    return count
  }

  return rows
    .map((row) => ({ row, score: matchCount(row) }))
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row)
}
