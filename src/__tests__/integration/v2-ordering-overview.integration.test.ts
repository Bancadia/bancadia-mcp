import { describe, it, expect, vi } from 'vitest'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }) }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})
// No vi.mock('../../lib/supabase'): real local Supabase, like the sibling suites.

import { mcpOk, activeListings, defaultOrderSlugs, rpc, affiliateKeys, db } from './v2-helpers'


const slugsOf = (rows: Array<{ listing_slug: string }>) => rows.map((r) => r.listing_slug)
const list = (args: Record<string, unknown> = {}) => mcpOk('list_business_checking', args).then((r) => r.data)

// Proves: sort precedence (hard filters, then client sort, then affiliate-tracked first, then fee, then id) is
// visible in the order of results, without ever naming affiliate status in a response.
describe('v2 ordering', () => {
  it('without a client sort, affiliate-tracked listings come first, then monthly_fee ascending, then id', async () => {
    const expected = await defaultOrderSlugs()
    const d = await list({ limit: 20 })
    expect(slugsOf(d.rows)).toEqual(expected)
    const affiliates = (await activeListings()).filter((l) => l.is_affiliate_tracked)
    expect(affiliates.length).toBeGreaterThan(0) // premise of this test
    expect(slugsOf(d.rows).slice(0, affiliates.length).sort()).toEqual(affiliates.map((a) => a.listing_slug).sort())
  })

  it('applies the same order after a hard filter (filters exclude, they do not reorder)', async () => {
    const expected = await defaultOrderSlugs((l) => l.monthly_fee <= 0)
    const d = await list({ monthly_fee_max: 0, limit: 20 })
    expect(slugsOf(d.rows)).toEqual(expected)
  })

  it('a client sort beats affiliate order: apy_max_desc puts the highest apy_max first even though affiliates have none', async () => {
    const { data: details } = await db.from('business_checking_details').select('listing_id, apy_max')
    const ids = new Map((await activeListings()).map((l) => [l.id, l]))
    const withApy = (details ?? []).filter((x) => ids.has(x.listing_id) && x.apy_max !== null)
    const top = withApy.sort((a, b) => b.apy_max! - a.apy_max!)[0]!
    expect(ids.get(top.listing_id)!.is_affiliate_tracked).toBe(false) // premise: an affiliate-first order would differ
    const d = await list({ sort: 'apy_max_desc', fields: ['apy_max'], limit: 20 })
    expect(d.rows[0].listing_slug).toBe(ids.get(top.listing_id)!.listing_slug)
    const vals = d.rows.map((r: any) => r.apy_max)
    const present = vals.filter((v: unknown) => v !== undefined)
    expect(present).toEqual([...present].sort((a: number, b: number) => b - a))
    // nulls (absent after slimming) sort last
    expect(vals.slice(present.length).every((v: unknown) => v === undefined)).toBe(true)
  })

  it('a client sort beats affiliate order: monthly_fee_desc lists the $15 listings before the affiliate-tracked $0 ones', async () => {
    const d = await list({ sort: 'monthly_fee_desc', fields: ['monthly_fee'], limit: 20 })
    const fees = d.rows.map((r: any) => r.monthly_fee)
    expect(fees).toEqual([...fees].sort((a: number, b: number) => b - a))
    expect(fees[0]).toBeGreaterThan(0)
  })

  it('rank_industries/rank_profiles only reorder: they never change total_matches', async () => {
    const base = await list({ limit: 20 })
    const ranked = await list({ rank_industries: ['ecommerce'], rank_profiles: ['early_stage_startup'], limit: 20 })
    expect(ranked.total_matches).toBe(base.total_matches)
    expect(slugsOf(ranked.rows).sort()).toEqual(slugsOf(base.rows).sort())
  })
})

// Proves: matches_overview is the whole unpaginated match list as {slug,name} only, consistent across pages, and
// absent when the page already contains every match.
describe('v2 matches_overview', () => {
  it('is in unpaginated order: overview slugs equal the unpaginated row slugs', async () => {
    const unpaginated = slugsOf((await list({ limit: 20 })).rows)
    const page = await list({ limit: 3 })
    expect(page.matches_overview.map((m: any) => m.slug)).toEqual(unpaginated)
  })

  it.each([0, 3, 6, 9])('the first rows of a page at offset %i equal overview[offset..]', async (offset) => {
    const page = await list({ limit: 3, offset })
    const ov = page.matches_overview.map((m: any) => m.slug)
    expect(slugsOf(page.rows)).toEqual(ov.slice(offset, offset + 3))
  })

  it('is identical on every page', async () => {
    const [a, b, c] = [await list({ limit: 4 }), await list({ limit: 4, offset: 4 }), await list({ limit: 4, offset: 8 })]
    expect(b.matches_overview).toEqual(a.matches_overview)
    expect(c.matches_overview).toEqual(a.matches_overview)
  })

  it('has total_matches entries, each with exactly slug and name', async () => {
    const page = await list({ limit: 3 })
    expect(page.matches_overview).toHaveLength(page.total_matches)
    for (const m of page.matches_overview) {
      expect(Object.keys(m).sort()).toEqual(['name', 'slug'])
      expect(typeof m.name).toBe('string')
    }
  })

  it('is absent when everything was returned (limit 20 >= matches)', async () => {
    const d = await list({ limit: 20 })
    expect(d.total_matches).toBe(d.returned)
    expect('matches_overview' in d).toBe(false)
  })

  it('is absent for a filter that matches only what the page returns', async () => {
    const d = await list({ entity_types_accepted: ['nonprofit'], monthly_fee_max: 0, limit: 20 })
    expect('matches_overview' in d).toBe(false)
  })

  it('never carries an application_url (or any link) in the overview', async () => {
    const page = await list({ limit: 3 })
    const text = JSON.stringify(page.matches_overview)
    expect(text).not.toContain('application_url')
    expect(text).not.toContain('/go/')
    expect(text).not.toContain('bancadia.com')
  })

  it('matches what the DB function returns (same overview, same order)', async () => {
    const direct = await rpc('list_business_checking', { p_filters: {}, p_limit: 3, p_offset: 0 })
    const page = await list({ limit: 3 })
    expect(page.matches_overview).toEqual(direct.matches_overview)
  })
})

// Proves: affiliate status is never exposed (no is_affiliate/tracker_url/affiliate_ keys in any response shape).
describe('v2 never exposes affiliate status', () => {
  it('no affiliate field names in list, search, fees or listing responses', async () => {
    const payloads = [
      await list({ limit: 20, fields: ['plan_tiers', 'promotions'] }),
      (await mcpOk('search_facts', { query: 'cash deposit' })).data,
      (await mcpOk('fees_by_type', { fee_types: ['cash_deposit', 'overdraft'] })).data,
      (await mcpOk('get_listing', { slugs: ['lili-business-checking', 'novo-business-checking'], sections: ['summary', 'tiers', 'fees', 'features', 'promotions'] })).data,
    ]
    for (const p of payloads) expect(affiliateKeys(p)).toEqual([])
  })
})
