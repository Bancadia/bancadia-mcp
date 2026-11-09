import { describe, it, expect, vi, beforeAll } from 'vitest'
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

// No vi.mock('../../lib/supabase') — this is the whole point of this suite.
// Requests hit the real local Supabase instance (env.SUPABASE_URL/
// SUPABASE_SECRET_KEY are injected by vitest.integration.config.mts).

import app from '../../index'
import { mockRedis, withSession } from '../helpers'
import { KNOWN_SLUGS, EXPECTED, ALL_KNOWN_SLUGS, APY_EXPECTED, APY_SLUGS } from './fixtures'
import { realSupabase } from './db-helpers'

// Real UUID, unique per test file run — query_events.session_id is
// UUID NOT NULL, and this also doubles as the isolation key for scoping
// query_events / query_match_events assertions without needing any DB-wide
// cleanup.
const SESSION_ID = crypto.randomUUID()

function post(body: object) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk_test_token',
      ...withSession({ 'Mcp-Session-Id': SESSION_ID }),
    },
    body: JSON.stringify(body),
  })
}

async function run(args: Record<string, unknown>) {
  const request = post({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'query_business_checking', arguments: args },
  })
  const ctx = createExecutionContext()
  const response = await app.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx) // ensures ctx.waitUntil(recordQueryEvent(...)) completes
  const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
  return JSON.parse(body.result.content[0].text) as Array<{ listing_slug: string } & Record<string, unknown>>
}

function scopeToKnown(results: Array<{ listing_slug: string }>) {
  return results.filter((r) => ALL_KNOWN_SLUGS.includes(r.listing_slug))
}

describe('query_business_checking — real local Supabase', () => {
  beforeAll(() => {
    // Cache-hit path so no real Supabase auth lookup happens in these
    // tests — auth.ts's real DB fallback is covered by
    // auth.integration.test.ts specifically.
    mockRedis({ tokenValid: true, tokenDeveloperId: null })
  })

  it('returns all 11 known (of 13 active) onboarding-script listings, shaped correctly', async () => {
    const results = await run({})
    const scoped = scopeToKnown(results)
    expect(scoped.length).toBe(ALL_KNOWN_SLUGS.length)

    const mercury = scoped.find((r) => r.listing_slug === KNOWN_SLUGS.mercury)
    expect(mercury).toMatchObject(EXPECTED[KNOWN_SLUGS.mercury])
  })

  it('records a query_events row and its query_match_events rows scoped to this test run session_id', async () => {
    const results = await run({})
    const { data: events, error } = await realSupabase()
      .from('query_events')
      .select('request_id, status, result_count, query_match_events(listing_slug, result_rank)')
      .eq('session_id', SESSION_ID)
      .eq('tool_name', 'query_business_checking')
      .eq('query_filters', '{}')
    expect(error).toBeNull()
    expect(events?.length).toBeGreaterThan(0)
    for (const e of events ?? []) {
      expect(e.status).toBe('ok')
      expect(e.result_count).toBe(results.length)
      expect(e.query_match_events.length).toBe(results.length)
    }
  })

  it('records a zero-result call as a query_events row with result_count 0 and no match rows', async () => {
    const results = await run({ monthly_fee_max: -1 })
    expect(results).toEqual([])
    const { data: events, error } = await realSupabase()
      .from('query_events')
      .select('status, result_count, query_match_events(listing_id)')
      .eq('session_id', SESSION_ID)
      .eq('query_filters', JSON.stringify({ monthly_fee_max: -1 }))
    expect(error).toBeNull()
    expect(events).toEqual([{ status: 'ok', result_count: 0, query_match_events: [] }])
  })

  it('monthly_fee_max excludes the two 15.00 listings but keeps the 0.00 ones', async () => {
    const results = await run({ monthly_fee_max: 10 })
    const slugs = scopeToKnown(results).map((r) => r.listing_slug)
    expect(slugs).toEqual(expect.arrayContaining([KNOWN_SLUGS.mercury, KNOWN_SLUGS.bluevine, KNOWN_SLUGS.novo]))
    expect(slugs).not.toContain(KNOWN_SLUGS.chase)
    expect(slugs).not.toContain(KNOWN_SLUGS.citibank)
  })

  it('entity_types_accepted excludes mercury (no sole_prop) but keeps novo (all 6 types)', async () => {
    const results = await run({ entity_types_accepted: ['sole_prop'] })
    const slugs = scopeToKnown(results).map((r) => r.listing_slug)
    expect(slugs).toContain(KNOWN_SLUGS.novo)
    expect(slugs).not.toContain(KNOWN_SLUGS.mercury)
  })

  it('rtp_supported=true proves the !inner join hint actually restricts rows, not just shapes the embed', async () => {
    const results = await run({ rtp_supported: true })
    const slugs = scopeToKnown(results).map((r) => r.listing_slug)
    expect(slugs).toContain(KNOWN_SLUGS.chase)
    // bluevine/novo have rtp_supported: false (mercury is true since migration 071) — if the !inner
    // hint were missing (the historical bug class this repo already shipped
    // once, for accounting_integration_available), this filter would be a
    // silent no-op and they'd leak through here too.
    expect(slugs).toContain(KNOWN_SLUGS.mercury)
    expect(slugs).not.toContain(KNOWN_SLUGS.bluevine)
    expect(slugs).not.toContain(KNOWN_SLUGS.novo)
  })

  describe('apy_min / apy_max / apy_default', () => {
    const apyScoped = (results: Array<{ listing_slug: string }>) =>
      results.filter((r) => APY_SLUGS.includes(r.listing_slug)).map((r) => r.listing_slug)

    it('returns apy_max and apy_default as seeded, with both null for non-interest-bearing listings', async () => {
      const results = await run({})
      for (const [slug, expected] of Object.entries(APY_EXPECTED)) {
        const row = results.find((r) => r.listing_slug === slug)
        expect(row, `${slug} missing from results`).toBeDefined()
        expect(row).toMatchObject(expected)
      }
      const mercury = results.find((r) => r.listing_slug === KNOWN_SLUGS.mercury)
      expect(mercury).toMatchObject({ apy_max: null, apy_default: null })
      // Karat went non-interest-bearing in bancadia-db migration 059.
      const karat = results.find((r) => r.listing_slug === 'karat-business-checking')
      expect(karat).toMatchObject({ interest_bearing: false, apy_max: null, apy_default: null })
    })

    it('apy_min filters on apy_max, not apy_default (found/bluevine have default < 0.02 <= max)', async () => {
      const slugs = apyScoped(await run({ apy_min: 0.02 }))
      // ramp sits exactly on the threshold, so this also proves gte is inclusive.
      expect(slugs.sort()).toEqual(
        [KNOWN_SLUGS.ramp, KNOWN_SLUGS.found, KNOWN_SLUGS.bluevine].sort()
      )
    })

    it('apy_min excludes listings whose apy_max is below the threshold', async () => {
      const slugs = apyScoped(await run({ apy_min: 0.02 }))
      expect(slugs).not.toContain(KNOWN_SLUGS.grasshopper) // 0.0135
      expect(slugs).not.toContain('highbeam-business-checking') // 0.0132
    })

    it('apy_min also excludes NULL-apy_max listings (the !inner join restricts rows)', async () => {
      const results = await run({ apy_min: 0.0001 })
      const slugs = results.map((r) => r.listing_slug)
      // All 8 non-interest-bearing checking listings have NULL apy_max
      // (Karat since bancadia-db migration 059).
      for (const slug of [KNOWN_SLUGS.mercury, KNOWN_SLUGS.novo, KNOWN_SLUGS.chase, KNOWN_SLUGS.citibank, 'karat-business-checking']) {
        expect(slugs).not.toContain(slug)
      }
      expect(apyScoped(results).sort()).toEqual([...APY_SLUGS].sort())
    })

    it('apy_min above every seeded apy_max returns none of the seeded listings', async () => {
      const results = await run({ apy_min: 0.034 })
      expect(apyScoped(results)).toEqual([])
    })
  })

  describe('affiliate-tracked ranking (Novo and Lili are is_affiliate_tracked via migration 061)', () => {
    const AFFILIATE = [KNOWN_SLUGS.novo, KNOWN_SLUGS.lili]

    it('ranks Novo and Lili ahead of every other known listing, including cheaper ones', async () => {
      const slugs = scopeToKnown(await run({})).map((r) => r.listing_slug)
      expect(slugs.slice(0, 2).sort()).toEqual([...AFFILIATE].sort())
    })

    it('never returns is_affiliate_tracked', async () => {
      for (const row of await run({})) expect(row).not.toHaveProperty('is_affiliate_tracked')
    })

    it('keeps an affiliate listing first among the results that pass the filter (cash_deposit_available)', async () => {
      const slugs = scopeToKnown(await run({ cash_deposit_available: true })).map((r) => r.listing_slug)
      expect(slugs[0]).toBe(KNOWN_SLUGS.lili)
      expect(slugs).not.toContain(KNOWN_SLUGS.novo)
    })

    it('excludes affiliate listings that fail the filter instead of promoting them (interest_bearing)', async () => {
      const slugs = scopeToKnown(await run({ interest_bearing: true })).map((r) => r.listing_slug)
      for (const s of AFFILIATE) expect(slugs).not.toContain(s)
      expect(slugs.length).toBeGreaterThan(0)
    })
  })

  it('monthly_fee ordering is stable across repeated calls against the same live dataset', async () => {
    const [first, second] = await Promise.all([run({}), run({})])
    expect(first.map((r) => r.listing_slug)).toEqual(second.map((r) => r.listing_slug))
  })
})
