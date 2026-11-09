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

import { mcpOk, rest, activeListings } from './v2-helpers'


const slugsOf = (rows: Array<{ listing_slug: string }>) => rows.map((r) => r.listing_slug)
const list = (args: Record<string, unknown> = {}) => mcpOk('list_business_checking', args).then((r) => r.data)

// Proves: the v2 list tool pages correctly (default 7, client limit up to 20, hard max 20 with the effective
// limit reported), total_matches is the unpaginated count, and next_offset chains pages without gaps or overlap.
describe('v2 list paging (MCP)', () => {
  it('defaults to 7 rows and reports limit 7, total_matches = all active listings, next_offset 7', async () => {
    const total = (await activeListings()).length
    const d = await list()
    expect(total).toBeGreaterThan(7)
    expect(d.limit).toBe(7)
    expect(d.returned).toBe(7)
    expect(d.rows).toHaveLength(7)
    expect(d.total_matches).toBe(total)
    expect(d.next_offset).toBe(7)
  })

  it('accepts limit 20 (the maximum) and returns everything when fewer than 20 match', async () => {
    const total = (await activeListings()).length
    const d = await list({ limit: 20 })
    expect(d.limit).toBe(20)
    expect(d.returned).toBe(Math.min(20, total))
    expect(d.next_offset).toBeNull()
  })

  it.each([21, 50, 1000])('clamps limit %i to 20 and reports the effective limit', async (limit) => {
    const d = await list({ limit })
    expect(d.limit).toBe(20)
    expect(d.rows.length).toBeLessThanOrEqual(20)
  })

  it('clamps limit 0 up to 1', async () => {
    const d = await list({ limit: 0 })
    expect(d.limit).toBe(1)
    expect(d.rows).toHaveLength(1)
  })

  it('total_matches equals the unlimited count for the same filter, whatever the page size', async () => {
    const all = await list({ monthly_fee_max: 0, limit: 20 })
    const small = await list({ monthly_fee_max: 0, limit: 2 })
    const direct = (await activeListings()).filter((l) => l.monthly_fee <= 0).length
    expect(all.total_matches).toBe(direct)
    expect(small.total_matches).toBe(direct)
    expect(all.returned).toBe(direct)
  })

  it('chains pages through next_offset: no gaps, no duplicates, same set as one unpaginated call', async () => {
    const unpaginated = slugsOf((await list({ limit: 20 })).rows)
    const seen: string[] = []
    let offset: number | null = 0
    let guard = 0
    while (offset !== null && guard++ < 10) {
      const page: any = await list({ limit: 5, offset })
      expect(page.limit).toBe(5)
      expect(page.rows.length).toBeLessThanOrEqual(5)
      seen.push(...slugsOf(page.rows))
      if (page.next_offset !== null) expect(page.next_offset).toBe(offset + page.returned)
      offset = page.next_offset
    }
    expect(offset).toBeNull()
    expect(seen).toEqual(unpaginated)
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('an offset past the end returns no rows, returned 0, next_offset null, and still the real total', async () => {
    const total = (await activeListings()).length
    const d = await list({ offset: 100 })
    expect(d.rows).toEqual([])
    expect(d.returned).toBe(0)
    expect(d.next_offset).toBeNull()
    expect(d.total_matches).toBe(total)
  })
})

// Proves: REST has the same paging semantics (default 7, max 20), with the data array unchanged in shape and the
// paging info in meta (a deliberate breaking change from "return everything").
describe('v2 list paging (REST parity)', () => {
  it('returns data as an array of rows with total_matches/returned/limit/next_offset in meta; default limit 7', async () => {
    const r = await rest('/business-checking-listings')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.data)).toBe(true)
    expect(r.body.data).toHaveLength(7)
    expect(r.body.meta).toMatchObject({ returned: 7, limit: 7, next_offset: 7, total_matches: (await activeListings()).length })
    expect(r.body.meta.count).toBe(7)
    expect(r.body.meta.request_id).toBe(r.requestId)
  })

  it('clamps limit=50 to 20 in meta.limit', async () => {
    const r = await rest('/business-checking-listings?limit=50')
    expect(r.status).toBe(200)
    expect(r.body.meta.limit).toBe(20)
  })

  it('page 2 over REST equals page 2 over MCP (same rows, same meta)', async () => {
    const m = await list({ limit: 5, offset: 5 })
    const r = await rest('/business-checking-listings?limit=5&offset=5')
    expect(slugsOf(r.body.data)).toEqual(slugsOf(m.rows))
    expect(r.body.meta).toMatchObject({
      total_matches: m.total_matches, returned: m.returned, limit: m.limit, next_offset: m.next_offset,
    })
  })

  it('offset past the end over REST is 200 with data []', async () => {
    const r = await rest('/business-checking-listings?offset=100')
    expect(r.status).toBe(200)
    expect(r.body.data).toEqual([])
    expect(r.body.meta.next_offset).toBeNull()
  })
})
