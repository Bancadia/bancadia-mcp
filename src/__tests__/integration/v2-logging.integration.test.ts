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

import { mcp, mcpOk, rest, eventsFor, db, deepKeys, K } from './v2-helpers'


const sid = () => crypto.randomUUID()
const slugsOf = (rows: any[]) => rows.map((r) => r.listing_slug)
const matchesOf = (e: any) => [...e.query_match_events].sort((a: any, b: any) => a.result_rank - b.result_rank)

// Proves: every v2 call writes one query_events row with the new columns, and query_match_events rows exist only
// for banks actually returned, with global ranks.
describe('v2 query_events columns', () => {
  it('list: profile, total_matches, offset, fields, result_count are all populated', async () => {
    const s = sid()
    const r = await mcpOk('list_business_checking', { monthly_fee_max: 0, limit: 3, offset: 2, fields: ['APY_Max'] }, { sessionId: s })
    const [e] = await eventsFor(s)
    expect(e).toMatchObject({
      tool_name: 'list_business_checking', channel: 'mcp', status: 'ok', profile: 'v2',
      total_matches: r.data.total_matches, offset: 2, result_count: 3,
    })
    expect(e.fields).toEqual(['apy_max'])
    expect(e.query_filters).toEqual({ monthly_fee_max: 0, limit: 3, offset: 2, fields: ['APY_Max'] })
  })

  it('list without offset/fields: offset 0, fields null', async () => {
    const s = sid()
    await mcpOk('list_business_checking', {}, { sessionId: s })
    const [e] = await eventsFor(s)
    expect(e.offset).toBe(0)
    expect(e.fields).toBeNull()
    expect(e.result_count).toBe(7)
  })

  it('search_facts / fees_by_type / get_listing log profile v2, result_count = rows returned, total_matches set', async () => {
    const a = sid(), b = sid(), c = sid()
    const sf = await mcpOk('search_facts', { query: 'wire', max_banks: 3 }, { sessionId: a })
    const fb = await mcpOk('fees_by_type', { fee_types: ['cash_deposit'] }, { sessionId: b })
    const gl = await mcpOk('get_listing', { slugs: [K.found, K.relay] }, { sessionId: c })
    const [ea] = await eventsFor(a), [eb] = await eventsFor(b), [ec] = await eventsFor(c)
    expect(ea).toMatchObject({ tool_name: 'search_facts', profile: 'v2', result_count: sf.data.hits.length, total_matches: sf.data.banks_matched })
    expect(eb).toMatchObject({ tool_name: 'fees_by_type', profile: 'v2', result_count: fb.data.length, total_matches: fb.data.length })
    expect(ec).toMatchObject({ tool_name: 'get_listing', profile: 'v2', result_count: 2, total_matches: 2 })
  })

  it('an invalid call is logged invalid_args with profile v2', async () => {
    const s = sid()
    const r = await mcp('list_business_checking', { insurance_type: 'bogus' }, { sessionId: s })
    expect(r.ok).toBe(false)
    const [e] = await eventsFor(s)
    expect(e).toMatchObject({ status: 'invalid_args', profile: 'v2', tool_name: 'list_business_checking' })
    expect(e.error_message).toMatch(/fdic/)
  })

  it('a legacy call is logged with profile legacy', async () => {
    const s = sid()
    await mcpOk('query_business_checking', { monthly_fee_max: 0 }, { sessionId: s, profile: 'legacy' })
    const [e] = await eventsFor(s)
    expect(e).toMatchObject({ tool_name: 'query_business_checking', profile: 'legacy', status: 'ok' })
  })

  it('REST list is logged channel rest, profile v2, request_id = X-Request-Id', async () => {
    const r = await rest('/business-checking-listings?limit=2&offset=1')
    const { data } = await db.from('query_events').select('*, query_match_events(listing_slug, result_rank)').eq('request_id', r.requestId)
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ channel: 'rest', profile: 'v2', session_id: null, offset: 1, result_count: 2, total_matches: r.body.meta.total_matches })
    expect(matchesOf(data![0]).map((m: any) => m.listing_slug)).toEqual(slugsOf(r.body.data))
  })
})

// Proves: REST sub-resource routes are logged as get_listing with the section, and record the one bank returned.
describe('REST sub-route logging', () => {
  it.each([['fees', 'fees'], ['features', 'features'], ['promotions', 'promotions'], ['plans', 'tiers']])('/%s -> get_listing sections [%s]', async (route, section) => {
    const r = await rest(`/business-checking-listings/${K.relay}/${route}`)
    expect(r.status).toBe(200)
    const { data } = await db.from('query_events').select('*, query_match_events(listing_slug, result_rank)').eq('request_id', r.requestId)
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ tool_name: 'get_listing', channel: 'rest', profile: 'v2', session_id: null, status: 'ok', result_count: 1, total_matches: 1, query_filters: { slugs: [K.relay], sections: [section] } })
    expect(matchesOf(data![0]).map((m: any) => [m.listing_slug, m.result_rank])).toEqual([[K.relay, 1]])
  })

  it('an unknown slug is a 404 logged with result_count 0 and no match rows', async () => {
    const r = await rest('/business-checking-listings/nope-nope/fees')
    expect(r.status).toBe(404)
    const { data } = await db.from('query_events').select('*, query_match_events(listing_slug)').eq('request_id', r.requestId)
    expect(data![0]).toMatchObject({ tool_name: 'get_listing', status: 'ok', result_count: 0 })
    expect(data![0].query_match_events).toEqual([])
  })

  it('a query param on a sub-route is a 400 logged as invalid_args', async () => {
    const r = await rest(`/business-checking-listings/${K.relay}/fees?plan=x`)
    expect(r.status).toBe(400)
    const { data } = await db.from('query_events').select('status, tool_name').eq('request_id', r.requestId)
    expect(data).toEqual([{ status: 'invalid_args', tool_name: 'get_listing' }])
  })
})

describe('v2 query_match_events', () => {
  it('only the returned page is recorded, ranked globally (offset 2, limit 3 -> ranks 3,4,5)', async () => {
    const s = sid()
    const r = await mcpOk('list_business_checking', { limit: 3, offset: 2 }, { sessionId: s })
    const [e] = await eventsFor(s)
    expect(e.total_matches).toBeGreaterThan(5) // matches beyond the page exist and are not recorded
    expect(matchesOf(e).map((m: any) => [m.listing_slug, m.result_rank])).toEqual(slugsOf(r.data.rows).map((slug: string, i: number) => [slug, 3 + i]))
    expect(e.query_match_events).toHaveLength(3)
  })

  it('matches_overview banks are not recorded', async () => {
    const s = sid()
    const r = await mcpOk('list_business_checking', { limit: 2 }, { sessionId: s })
    const [e] = await eventsFor(s)
    expect(r.data.matches_overview.length).toBeGreaterThan(2)
    expect(e.query_match_events).toHaveLength(2)
  })

  it('listing ids recorded are the real ids of the returned slugs', async () => {
    const s = sid()
    const r = await mcpOk('list_business_checking', { limit: 3 }, { sessionId: s })
    const [e] = await eventsFor(s)
    const { data: accts } = await db.from('business_deposit_accounts').select('id, listing_slug').in('listing_slug', slugsOf(r.data.rows))
    const byId = new Map(accts!.map((a) => [a.id, a.listing_slug]))
    for (const m of e.query_match_events) expect(byId.get(m.listing_id)).toBe(m.listing_slug)
  })

  it('search_facts: only banks in hits are recorded, never no_match banks', async () => {
    const s = sid()
    const r = await mcpOk('search_facts', { query: 'barcode', slugs: [K.found, K.mercury, K.citibank] }, { sessionId: s })
    expect(r.data.no_match.length).toBeGreaterThan(0)
    const [e] = await eventsFor(s)
    expect(matchesOf(e).map((m: any) => m.listing_slug)).toEqual(r.data.hits.map((h: any) => h.slug))
  })

  it('get_listing: found listings recorded in input order, not_found never', async () => {
    const s = sid()
    await mcpOk('get_listing', { slugs: [K.relay, 'nope', K.found] }, { sessionId: s })
    const [e] = await eventsFor(s)
    expect(matchesOf(e).map((m: any) => [m.listing_slug, m.result_rank])).toEqual([[K.relay, 1], [K.found, 2]])
  })

  it('fees_by_type: the banks returned are recorded in order', async () => {
    const s = sid()
    const r = await mcpOk('fees_by_type', { fee_types: ['cash_deposit'] }, { sessionId: s })
    const [e] = await eventsFor(s)
    expect(matchesOf(e).map((m: any) => m.listing_slug)).toEqual(r.data.map((b: any) => b.slug))
  })
})

// Proves: internal keys never reach clients, on any tool or on REST.
describe('v2 returned_ids never leaks', () => {
  it('no returned_ids key or listing uuid appears in any response', async () => {
    const { data: all } = await db.from('business_deposit_accounts').select('id')
    const ids = (all ?? []).map((a) => a.id)
    const texts = [
      (await mcpOk('list_business_checking', { limit: 20 })).text,
      (await mcpOk('search_facts', { query: 'wire' })).text,
      (await mcpOk('fees_by_type', { fee_types: ['cash_deposit'] })).text,
      (await mcpOk('get_listing', { slugs: [K.found] })).text,
      (await rest('/business-checking-listings?limit=20')).text,
      (await rest('/business-checking-listings/-/facts?query=wire')).text,
      (await rest('/business-checking-listings/-/fees?fee_types=cash_deposit')).text,
      (await rest(`/business-checking-listings/${K.found}/fees`)).text,
      (await rest(`/business-checking-listings/${K.relay}/plans`)).text,
      (await rest(`/business-checking-listings/${K.found}`)).text,
    ]
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(10)
      expect(t).not.toContain('returned_ids')
      for (const id of ids) expect(t).not.toContain(id)
      expect(deepKeys(JSON.parse(t)).filter((k) => /^(is_affiliate|tracker_url|affiliate_)/.test(k))).toEqual([])
    }
  })
})
