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

type Row = { listing_slug: string } & Record<string, unknown>
type RestBody = { data: Row[]; meta: { count: number; request_id: string; filters?: unknown } }

async function rest(path: string, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext()
  const response = await app.fetch(new Request(`http://localhost/v1${path}`, { headers }), env, ctx)
  await waitOnExecutionContext(ctx) // flushes ctx.waitUntil(recordQueryEvent(...))
  return response
}

const restList = async (query: string) => {
  const res = await rest(`/business-checking${query ? `?${query}` : ''}`)
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
  if (taggedListingId) await db.from('business_deposit_account_target_segments').delete().eq('listing_id', taggedListingId)
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
    const ca = scoped((await restList('available_states=CA')).data)
    expect(ca.sort()).toEqual(ALL_KNOWN_SLUGS.filter((s) => s !== STATE_SLUG).sort())
    const ny = scoped((await restList('available_states=NY')).data)
    expect(ny.sort()).toEqual([...ALL_KNOWN_SLUGS].sort())
    const nyCa = scoped((await restList('available_states=NY,CA')).data)
    expect(nyCa).not.toContain(STATE_SLUG)
    expect(nyCa.length).toBe(ALL_KNOWN_SLUGS.length - 1)
  })

  it('11. a filter set that matches nothing is 200 with data [] and count 0', async () => {
    const body = await restList('monthly_fee_max=-1')
    expect(body.data).toEqual([])
    expect(body.meta.count).toBe(0)
  })

  it('12. target_industries re-orders (tagged listing floats up) but never changes the set', async () => {
    const baseline = slugsOf((await restList('monthly_fee_max=0')).data)
    const lastFree = [...baseline].reverse().find((s) => ALL_KNOWN_SLUGS.includes(s))!
    taggedListingId = await lookupListingIdBySlug(lastFree)
    const { error } = await db
      .from('business_deposit_account_target_segments')
      .insert({ listing_id: taggedListingId, category: 'industry_vertical', segment: 'ecommerce' })
    expect(error).toBeNull()

    const ranked = slugsOf((await restList('monthly_fee_max=0&target_industries=ecommerce')).data)
    expect(ranked[0]).toBe(lastFree)
    expect(baseline.indexOf(lastFree)).toBeGreaterThan(0)
    expect([...ranked].sort()).toEqual([...baseline].sort())
    await db.from('business_deposit_account_target_segments').delete().eq('listing_id', taggedListingId)
    taggedListingId = null
  })

  describe('13. parity: REST slug list (in order) equals MCP tools/call for the same args', () => {
    for (const c of REST_FILTER_CASES) {
      it(c.name, async () => {
        const [r, m] = await Promise.all([restList(c.query), mcp('query_business_checking', c.mcp, SESSION_ID, { Authorization: 'Bearer sk_test_token' })])
        expect(slugsOf(r.data)).toEqual(slugsOf(m.results))
      })
    }
    it('available_states', async () => {
      const [r, m] = await Promise.all([
        restList('available_states=CA,NY'),
        mcp('query_business_checking', { available_states: ['CA', 'NY'] }, SESSION_ID),
      ])
      expect(slugsOf(r.data)).toEqual(slugsOf(m.results))
    })
  })

  describe('14. detail', () => {
    it('known slug returns plan_tiers, general_fees and general_features matching the DB and the MCP tool', async () => {
      const slug = KNOWN_SLUGS.bluevine
      const res = await rest(`/business-checking/${slug}`)
      expect(res.status).toBe(200)
      const { data } = await res.json<{ data: Record<string, unknown> }>()
      expect(data.listing_slug).toBe(slug)

      const id = await lookupListingIdBySlug(slug)
      const [tiers, fees, feats] = await Promise.all([
        db.from('business_deposit_plan_tiers').select('id').eq('listing_id', id),
        // wire/cash-deposit fees are exposed as flat columns, not under general_fees (same rule as the contract suite)
        db.from('business_deposit_fees').select('id').eq('listing_id', id).is('plan_tier_id', null)
          .not('fee_type', 'in', '(wire_domestic_outgoing,wire_domestic_incoming,wire_international_outgoing,wire_international_incoming,cash_deposit)'),
        db.from('business_deposit_account_features').select('id').eq('listing_id', id).is('plan_tier_id', null),
      ])
      expect((data.plan_tiers as unknown[]).length).toBe(tiers.data!.length)
      expect((data.general_fees as unknown[]).length).toBe(fees.data!.length)
      expect((data.general_features as unknown[]).length).toBe(feats.data!.length)
      expect(tiers.data!.length).toBeGreaterThan(0)
      expect(fees.data!.length + feats.data!.length).toBeGreaterThan(0)

      const m = await mcp('get_business_checking_listing', { listing_slug: slug }, SESSION_ID)
      const strip = (o: Record<string, unknown>) => ({ ...o, application_url: undefined })
      expect(strip(data)).toEqual(strip(m.results[0]))
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
        .select('channel, session_id, developer_id, result_count, status, tool_name, query_match_events(listing_slug)')
        .eq('request_id', body.meta.request_id)
        .single()
      expect(error).toBeNull()
      expect(data).toMatchObject({
        channel: 'rest',
        session_id: null,
        developer_id: null,
        result_count: body.data.length,
        status: 'ok',
        tool_name: 'query_business_checking',
      })
      expect(data!.query_match_events.length).toBe(body.data.length)
    })

    it('detail call: one query_match_events row with the listing institution_id', async () => {
      const slug = KNOWN_SLUGS.novo
      const res = await rest(`/business-checking/${slug}`)
      const { meta } = await res.json<{ meta: { request_id: string } }>()
      const { data: acct } = await db.from('business_deposit_accounts').select('id, institution_id').eq('listing_slug', slug).single()
      const { data, error } = await db
        .from('query_events')
        .select('channel, session_id, developer_id, result_count, tool_name, query_match_events(listing_id, institution_id, listing_slug)')
        .eq('request_id', meta.request_id)
        .single()
      expect(error).toBeNull()
      expect(data).toMatchObject({ channel: 'rest', session_id: null, developer_id: null, result_count: 1, tool_name: 'get_business_checking_listing' })
      expect(data!.query_match_events).toEqual([{ listing_id: acct!.id, institution_id: acct!.institution_id, listing_slug: slug }])
    })
  })

  it('16. anonymous MCP tools/call (no Authorization) succeeds and logs developer_id NULL, channel mcp', async () => {
    const m = await mcp('query_business_checking', { monthly_fee_max: -1 }, ANON_SESSION_ID)
    expect(m.status).toBe(200)
    expect(m.results).toEqual([])
    const { data, error } = await db.from('query_events').select('channel, developer_id, session_id, status').eq('session_id', ANON_SESSION_ID)
    expect(error).toBeNull()
    expect(data).toEqual([{ channel: 'mcp', developer_id: null, session_id: ANON_SESSION_ID, status: 'ok' }])
  })
})
