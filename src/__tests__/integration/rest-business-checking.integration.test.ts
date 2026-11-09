import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return {
      limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }),
    }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

// No vi.mock('../../lib/supabase') -- real local Supabase, like the sibling suites.

import app from '../../index'
import { mockRedis, withSession } from '../helpers'
import { KNOWN_SLUGS, ALL_KNOWN_SLUGS, REST_FILTER_CASES } from './fixtures'
import { realSupabase, lookupListingIdBySlug } from './db-helpers'
import { mcpOk } from './v2-helpers'

type Row = { listing_slug: string } & Record<string, unknown>
type RestBody = { data: Row[]; meta: { count: number; request_id: string; filters?: unknown; total_matches: number } }

async function rest(path: string, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext()
  const response = await app.fetch(new Request(`http://localhost/v1${path}`, { headers }), env, ctx)
  await waitOnExecutionContext(ctx) // flushes ctx.waitUntil(recordQueryEvent(...))
  return response
}

// REST is v2: default page is 7, so ask for the max page (13 seeded listings fit) to compare full sets.
const restList = async (query: string) => {
  const res = await rest(`/business-checking-listings?${query ? `${query}&` : ''}limit=20`)
  expect(res.status).toBe(200)
  return res.json<RestBody>()
}

async function mcp(name: string, args: Record<string, unknown>, sessionId: string, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext()
  const response = await app.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...withSession({ 'Mcp-Session-Id': sessionId }), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
  return { status: response.status, results: JSON.parse(body.result.content[0].text) as Row[] }
}

const scoped = (rows: Row[]) => rows.map((r) => r.listing_slug).filter((s) => ALL_KNOWN_SLUGS.includes(s))
const slugsOf = (rows: Row[]) => rows.map((r) => r.listing_slug)
const db = realSupabase()
const SESSION_ID = crypto.randomUUID()
const ANON_SESSION_ID = crypto.randomUUID()

// Temporary DB mutations (restored in afterAll): the seed has no state-restricted listing and no segment tags.
const STATE_SLUG = KNOWN_SLUGS.rho
let restoreStates: string[] | null = null
let taggedListingId: string | null = null

beforeAll(async () => {
  mockRedis({ tokenValid: true, tokenDeveloperId: null })
  const { data } = await db.from('business_deposit_accounts').select('available_states').eq('listing_slug', STATE_SLUG).single()
  restoreStates = data!.available_states as string[]
  const { error } = await db.from('business_deposit_accounts').update({ available_states: ['NY', 'TX'] }).eq('listing_slug', STATE_SLUG)
  expect(error).toBeNull()
})

afterAll(async () => {
  if (restoreStates) await db.from('business_deposit_accounts').update({ available_states: restoreStates }).eq('listing_slug', STATE_SLUG)
  if (taggedListingId) await db.from('business_deposit_account_target_segments').delete().eq('listing_id', taggedListingId).eq('segment', 'ecommerce')
})

describe('REST /v1/business-checking -- real local Supabase', () => {
  describe('cases 1-11: exact slug sets (scoped to known listings)', () => {
    for (const c of REST_FILTER_CASES) {
      it(c.name, async () => {
        const body = await restList(c.query)
        // rho is temporarily restricted to NY/TX but that only matters for available_states filters.
        expect(scoped(body.data).sort()).toEqual([...c.slugs].sort())
        expect(body.meta.count).toBe(body.data.length)
      })
    }
  })

  it('5. available_states: ["ALL"] is a wildcard, a state-restricted listing only matches its states', async () => {
    // Expected sets come from the DB's current available_states (rho mutated above), so state-restricted
    // listings that dev may already have don't break the assumptions.
    const { data } = await db.from('business_deposit_accounts').select('listing_slug, available_states').in('listing_slug', ALL_KNOWN_SLUGS)
    const expected = (states: string[]) =>
      data!.filter((r) => states.every((s) => (r.available_states as string[]).some((a) => a === 'ALL' || a === s))).map((r) => r.listing_slug).sort()
    for (const q of [['CA'], ['NY'], ['NY', 'CA']]) {
      expect(scoped((await restList(`available_states=${q.join(',')}`)).data).sort()).toEqual(expected(q))
    }
    // rho (NY/TX only) must be excluded whenever CA is requested
    expect(expected(['CA'])).not.toContain(STATE_SLUG)
    expect(expected(['NY'])).toContain(STATE_SLUG)
  })

  it('11. a filter set that matches nothing is 200 with data [] and count 0', async () => {
    const body = await restList('monthly_fee_max=-1')
    expect(body.data).toEqual([])
    expect(body.meta.count).toBe(0)
  })

  it('12. target_industries re-orders (tagged listing floats up) but never changes the set', async () => {
    // Independent of pre-existing tags in the target DB (dev already tags some listings 'ecommerce').
    const baseline = slugsOf((await restList('monthly_fee_max=0')).data)
    const before = (await restList('monthly_fee_max=0&rank_industries=ecommerce&fields=target_industries')).data
    const hasTag = (r: Row) => ((r.target_industries as string[] | undefined) ?? []).includes('ecommerce')
    // Last untagged known listing: always ranks behind every tagged one pre-tag, so tagging it must move it up.
    const candidate = [...before].reverse().find((r) => ALL_KNOWN_SLUGS.includes(r.listing_slug) && !hasTag(r))?.listing_slug
    if (!candidate) throw new Error("no known listing without an 'ecommerce' tag in the target DB to use as a candidate")
    const listingId = await lookupListingIdBySlug(candidate)
    const { error } = await db
      .from('business_deposit_account_target_segments')
      .insert({ listing_id: listingId, category: 'industry_vertical', segment: 'ecommerce' })
    expect(error).toBeNull()
    taggedListingId = listingId // only set once the insert succeeded, so cleanup never deletes a pre-existing tag
    try {
      const after = (await restList('monthly_fee_max=0&rank_industries=ecommerce&fields=target_industries')).data
      expect([...slugsOf(after)].sort()).toEqual([...baseline].sort())
      expect(slugsOf(after).indexOf(candidate)).toBeLessThan(slugsOf(before).indexOf(candidate))
      // every tagged listing ranks ahead of every untagged one
      const tags = after.map(hasTag)
      expect(tags.indexOf(false) === -1 || tags.lastIndexOf(true) < tags.indexOf(false)).toBe(true)
    } finally {
      await db.from('business_deposit_account_target_segments').delete().eq('listing_id', listingId).eq('segment', 'ecommerce')
      taggedListingId = null
    }
  })

  describe('13. parity: REST slug list (in order) equals MCP tools/call for the same args', () => {
    for (const c of REST_FILTER_CASES) {
      it(c.name, async () => {
        const r = await restList(c.query)
        const m = await mcpOk('list_business_checking', { ...c.mcp, limit: 20 })
        expect(slugsOf(r.data)).toEqual(slugsOf(m.data.rows))
      })
    }
    it('available_states', async () => {
      const r = await restList('available_states=CA,NY')
      const m = await mcpOk('list_business_checking', { available_states: ['CA', 'NY'], limit: 20 })
      expect(slugsOf(r.data)).toEqual(slugsOf(m.data.rows))
    })
  })

  describe('14. detail', () => {
    it('known slug returns the requested sections, matching the DB counts and the MCP get_listing tool', async () => {
      const slug = KNOWN_SLUGS.bluevine
      const res = await rest(`/business-checking-listings/${slug}?sections=tiers,fees,features`)
      expect(res.status).toBe(200)
      const { data } = await res.json<{ data: Record<string, unknown> }>()
      expect(data.slug).toBe(slug)

      const id = await lookupListingIdBySlug(slug)
      const [tiers, fees, feats] = await Promise.all([
        db.from('business_deposit_plan_tiers').select('id').eq('listing_id', id),
        db.from('business_deposit_fees').select('id').eq('listing_id', id),
        db.from('business_deposit_account_features').select('id').eq('listing_id', id),
      ])
      expect(tiers.data!.length).toBeGreaterThan(0)
      expect(fees.data!.length + feats.data!.length).toBeGreaterThan(0)
      expect((data.tiers as unknown[]).length).toBe(tiers.data!.length)
      expect(data.detail_has).toEqual(expect.arrayContaining([`tiers:${tiers.data!.length}`]))

      const m = await mcpOk('get_listing', { slugs: [slug], sections: ['tiers', 'fees', 'features'] })
      const strip = (o: Record<string, unknown>) => ({ ...o, application_url: undefined })
      expect(strip(data)).toEqual(strip(m.data.listings[0]))
    })

    it('unknown slug is a 404 problem+json', async () => {
      const res = await rest('/business-checking/not-a-real-listing-slug')
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('application/problem+json')
      expect(await res.json()).toMatchObject({ status: 404 })
    })
  })

  describe('15. logging', () => {
    it('list call: query_events row has channel rest, no session, no developer, right result_count', async () => {
      const body = await restList('monthly_fee_max=0')
      const { data, error } = await db
        .from('query_events')
        .select('channel, session_id, developer_id, result_count, status, tool_name, profile, query_match_events(listing_slug)')
        .eq('request_id', body.meta.request_id)
        .single()
      expect(error).toBeNull()
      expect(data).toMatchObject({
        channel: 'rest',
        session_id: null,
        developer_id: null,
        result_count: body.data.length,
        status: 'ok',
        tool_name: 'list_business_checking',
        profile: 'v2',
      })
      expect(data!.query_match_events.length).toBe(body.data.length)
      expect(body.meta.total_matches).toBeGreaterThanOrEqual(body.data.length)
    })

    it('detail call: one query_match_events row with the listing institution_id', async () => {
      const slug = KNOWN_SLUGS.novo
      const res = await rest(`/business-checking-listings/${slug}`)
      const { meta } = await res.json<{ meta: { request_id: string } }>()
      const { data: acct } = await db.from('business_deposit_accounts').select('id').eq('listing_slug', slug).single()
      const { data, error } = await db
        .from('query_events')
        .select('channel, session_id, developer_id, result_count, tool_name, query_match_events(listing_id, institution_id, listing_slug)')
        .eq('request_id', meta.request_id)
        .single()
      expect(error).toBeNull()
      expect(data).toMatchObject({ channel: 'rest', session_id: null, developer_id: null, result_count: 1, tool_name: 'get_listing' })
      // v2 logs from the DB's returned_ids, which carry no institution (spec section 6: institution_id null)
      expect(data!.query_match_events).toEqual([{ listing_id: acct!.id, institution_id: null, listing_slug: slug }])
    })
  })

  it('16. anonymous MCP tools/call (no Authorization) succeeds and logs developer_id NULL, channel mcp', async () => {
    // earlier v2 helpers leave a v2-profile session mock behind; this legacy tool needs a legacy session
    mockRedis({ tokenValid: true, tokenDeveloperId: null, sessionProfile: 'legacy' })
    const m = await mcp('query_business_checking', { monthly_fee_max: -1 }, ANON_SESSION_ID)
    expect(m.status).toBe(200)
    expect(m.results).toEqual([])
    const { data, error } = await db.from('query_events').select('channel, developer_id, session_id, status').eq('session_id', ANON_SESSION_ID)
    expect(error).toBeNull()
    expect(data).toEqual([{ channel: 'mcp', developer_id: null, session_id: ANON_SESSION_ID, status: 'ok' }])
  })
})
