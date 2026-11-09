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

import { mcpOk, mcpErr, rest, db, activeListings, eventsFor, expectTaggedUrl, K } from './v2-helpers'

const list = (args: Record<string, unknown> = {}, opts: Parameters<typeof mcpOk>[2] = {}) =>
  mcpOk('list_business_checking', { limit: 20, ...args }, opts).then((r) => r.data)
const slugsOf = (rows: Array<{ listing_slug: string }>) => rows.map((r) => r.listing_slug)

// The oracle: promotions straight from the table, active = expiry_date null or >= today (UTC).
async function promotionsBySlug() {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await db.from('business_deposit_promotions').select('listing_id, expiry_date')
  if (error) throw new Error(error.message)
  const listings = await activeListings()
  const bySlug = new Map(listings.map((l) => [l.listing_slug, { total: 0, active: 0 }]))
  const idToSlug = new Map(listings.map((l) => [l.id, l.listing_slug]))
  for (const p of data!) {
    const slug = idToSlug.get(p.listing_id)
    if (!slug) continue
    const e = bySlug.get(slug)!
    e.total++
    if (p.expiry_date === null || p.expiry_date >= today) e.active++
  }
  return bySlug
}

// Proves: has_active_promotion filters on active promotions only (computed independently from the table), the
// complement partitions the listings, rows carry active promotions only, and nothing else about the list changes.
describe('has_active_promotion (MCP)', () => {
  it('true returns exactly the listings with at least one active promotion, false the complement, sums to all', async () => {
    const promos = await promotionsBySlug()
    const withActive = [...promos].filter(([, v]) => v.active > 0).map(([s]) => s).sort()
    expect(withActive.length).toBeGreaterThan(0)
    const yes = await list({ has_active_promotion: true })
    const no = await list({ has_active_promotion: false })
    expect(slugsOf(yes.rows).sort()).toEqual(withActive)
    expect(slugsOf(no.rows).sort()).toEqual([...promos.keys()].filter((s) => !withActive.includes(s)).sort())
    expect(yes.total_matches + no.total_matches).toBe(promos.size)
  })

  it('rows carry only the active promotions (Chase has 4 rows, only the non-expired ones appear), even when fields omits promotions', async () => {
    const promos = await promotionsBySlug()
    expect(promos.get(K.chase)!.total).toBe(4)
    const d = await list({ has_active_promotion: true, fields: ['monthly_fee'] })
    for (const row of d.rows) expect(row.promotions.length).toBe(promos.get(row.listing_slug)!.active)
    const chase = d.rows.find((r: any) => r.listing_slug === K.chase)
    expect(chase.promotions.length).toBe(promos.get(K.chase)!.active)
    expect(chase.promotions.length).toBeLessThan(4)
    const today = new Date().toISOString().slice(0, 10)
    for (const row of d.rows) for (const p of row.promotions) expect(!p.expiry_date || p.expiry_date >= today).toBe(true)
  })

  it('combined with another filter equals the intersection', async () => {
    const yes = slugsOf((await list({ has_active_promotion: true })).rows)
    const fee0 = slugsOf((await list({ monthly_fee_max: 0 })).rows)
    const both = await list({ has_active_promotion: true, monthly_fee_max: 0 })
    expect(slugsOf(both.rows).sort()).toEqual(yes.filter((s) => fee0.includes(s)).sort())
    expect(both.excluded_by.has_active_promotion).toBeGreaterThan(0)
  })

  it('every row has a tagged application_url; matches_overview appears only when matches exceed the page, without urls', async () => {
    const d = await list({ has_active_promotion: true, limit: 1 })
    expect(d.total_matches).toBeGreaterThan(1)
    for (const row of d.rows) expectTaggedUrl(row.application_url, 'mcp')
    expect(d.matches_overview).toHaveLength(d.total_matches)
    expect(JSON.stringify(d.matches_overview)).not.toContain('application_url')
    const all = await list({ has_active_promotion: true })
    expect('matches_overview' in all).toBe(false)
  })

  it('notes carries the promotion caveat only when the filter was supplied (true or false)', async () => {
    const plain = await list()
    expect(plain.notes).not.toMatch(/Promotions are recorded/)
    for (const v of [true, false]) {
      const d = await list({ has_active_promotion: v })
      expect(d.notes).toMatch(/Promotions are recorded for only some banks/)
      expect(d.notes).not.toMatch(/\n/)
      expect(d.notes.length).toBeLessThanOrEqual(300)
    }
  })

  it('logs the filter as received, result_count = rows returned, and match rows only for the page', async () => {
    const s = crypto.randomUUID()
    const d = await list({ has_active_promotion: true, limit: 1 }, { sessionId: s })
    const [e] = await eventsFor(s)
    expect(e).toMatchObject({ tool_name: 'list_business_checking', status: 'ok', profile: 'v2', result_count: 1, total_matches: d.total_matches, offset: 0 })
    expect(e.query_filters).toEqual({ has_active_promotion: true, limit: 1 })
    expect(e.query_match_events.map((m: any) => m.listing_slug)).toEqual(slugsOf(d.rows))
  })

  it('a non-boolean value is -32602 naming the argument (schema type check)', async () => {
    const r = await mcpErr('list_business_checking', { has_active_promotion: 'yes' })
    expect(r.code).toBe(-32602)
    expect(r.message).toMatch(/has_active_promotion/)
  })
})

describe('has_active_promotion (REST)', () => {
  it('true/false match the MCP result; meta carries the notes caveat; alias behaves the same', async () => {
    for (const v of ['true', 'false']) {
      const m = await list({ has_active_promotion: v === 'true' })
      const r = await rest(`/business-checking-listings?has_active_promotion=${v}&limit=20`)
      expect(r.status).toBe(200)
      expect(slugsOf(r.body.data).sort()).toEqual(slugsOf(m.rows).sort())
      expect(r.body.meta.total_matches).toBe(m.total_matches)
      expect(r.body.meta.notes).toMatch(/Promotions are recorded for only some banks/)
      expect(r.body.meta.filters).toMatchObject({ has_active_promotion: v === 'true' })
      for (const row of r.body.data) expectTaggedUrl(row.application_url, 'rest')
      const alias = await rest(`/business-checking?has_active_promotion=${v}&limit=20`)
      expect(slugsOf(alias.body.data).sort()).toEqual(slugsOf(r.body.data).sort())
    }
  })

  it('a bad value is a 400 problem naming the parameter', async () => {
    const r = await rest('/business-checking-listings?has_active_promotion=maybe')
    expect(r.status).toBe(400)
    expect(r.body.detail).toMatch(/has_active_promotion/)
  })

  it('the DB message passes through when a non-boolean reaches the DB (direct rpc check of the error text)', async () => {
    const { error } = await db.rpc('list_business_checking' as never, { p_filters: { has_active_promotion: 'x' } } as never)
    expect(error?.code).toBe('22023')
    expect(error?.message).toMatch(/has_active_promotion must be true or false/)
  })
})
