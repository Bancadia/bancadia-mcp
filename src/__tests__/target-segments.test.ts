import { describe, it, expect } from 'vitest'
import { Constants } from '../lib/database.types'
import {
  INDUSTRY_VERTICAL_DESCRIPTIONS,
  BUSINESS_PROFILE_DESCRIPTIONS,
  bucketTargetSegments,
  rankByTargetSegments,
} from '../lib/target-segments'

describe('target segment descriptions vs. generated DB enum', () => {
  it('industry + business_profile descriptions cover every DB enum value exactly once, with no leftovers', () => {
    const combined = [
      ...Object.keys(INDUSTRY_VERTICAL_DESCRIPTIONS),
      ...Object.keys(BUSINESS_PROFILE_DESCRIPTIONS),
    ].sort()
    expect(combined).toEqual([...Constants.public.Enums.target_segment_enum].sort())
  })

  it('industry and business_profile description sets do not overlap', () => {
    const industryKeys = new Set(Object.keys(INDUSTRY_VERTICAL_DESCRIPTIONS))
    const profileKeys = Object.keys(BUSINESS_PROFILE_DESCRIPTIONS)
    const overlap = profileKeys.filter((k) => industryKeys.has(k))
    expect(overlap).toEqual([])
  })
})

describe('bucketTargetSegments', () => {
  it('splits rows into the two facets and dedupes by segment, independent of the DB UNIQUE constraint', () => {
    const result = bucketTargetSegments([
      { category: 'industry_vertical', segment: 'saas_tech' },
      { category: 'industry_vertical', segment: 'saas_tech' }, // duplicate — must not appear twice
      { category: 'business_profile', segment: 'early_stage_startup' },
    ])
    expect(result.target_industries).toEqual(['saas_tech'])
    expect(result.target_business_profiles).toEqual(['early_stage_startup'])
  })

  it('returns empty arrays, not null/undefined, for a null or empty input', () => {
    expect(bucketTargetSegments(null)).toEqual({ target_industries: [], target_business_profiles: [] })
    expect(bucketTargetSegments(undefined)).toEqual({ target_industries: [], target_business_profiles: [] })
    expect(bucketTargetSegments([])).toEqual({ target_industries: [], target_business_profiles: [] })
  })
})

describe('rankByTargetSegments', () => {
  const row = (id: string, segments: Array<{ category: string; segment: string }>) => ({
    id,
    business_deposit_account_target_segments: segments,
  })

  it('is a no-op (same array reference) when nothing was requested', () => {
    const rows = [row('a', []), row('b', [])]
    expect(rankByTargetSegments(rows, [], [])).toBe(rows)
  })

  it('a duplicated segment on one row does not inflate its score past a row with more distinct matches', () => {
    const inflated = row('inflated', [
      { category: 'industry_vertical', segment: 'saas_tech' },
      { category: 'industry_vertical', segment: 'saas_tech' },
      { category: 'industry_vertical', segment: 'saas_tech' },
    ])
    const genuinelyTwo = row('genuine-two', [
      { category: 'industry_vertical', segment: 'saas_tech' },
      { category: 'business_profile', segment: 'early_stage_startup' },
    ])

    const ranked = rankByTargetSegments([inflated, genuinelyTwo], ['saas_tech'], ['early_stage_startup'])

    expect(ranked.map((r) => r.id)).toEqual(['genuine-two', 'inflated'])
  })

  it('ranks by combined match count across both facets, descending', () => {
    const rows = [
      row('zero-match', []),
      row('one-match', [{ category: 'industry_vertical', segment: 'saas_tech' }]),
      row('two-match', [
        { category: 'industry_vertical', segment: 'saas_tech' },
        { category: 'business_profile', segment: 'early_stage_startup' },
      ]),
    ]

    const ranked = rankByTargetSegments(rows, ['saas_tech'], ['early_stage_startup'])

    expect(ranked.map((r) => r.id)).toEqual(['two-match', 'one-match', 'zero-match'])
  })
})
