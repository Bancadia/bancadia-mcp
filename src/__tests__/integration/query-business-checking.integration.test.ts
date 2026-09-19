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

// Real UUID, unique per test file run — query_match_events.session_id is
// UUID NOT NULL, and this also doubles as the isolation key for scoping
// query_match_events assertions without needing any DB-wide cleanup.
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
  await waitOnExecutionContext(ctx) // ensures ctx.waitUntil(recordMatchEvents(...)) completes
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

  it('returns all 11 known onboarding-script listings, shaped correctly', async () => {
    const results = await run({})
    const scoped = scopeToKnown(results)
    expect(scoped.length).toBe(ALL_KNOWN_SLUGS.length)

    const mercury = scoped.find((r) => r.listing_slug === KNOWN_SLUGS.mercury)
    expect(mercury).toMatchObject(EXPECTED[KNOWN_SLUGS.mercury])
  })

  it('records query_match_events scoped to this test run session_id', async () => {
    await run({})
    const { data, error } = await realSupabase()
      .from('query_match_events')
      .select('listing_slug, session_id')
      .eq('session_id', SESSION_ID)
    expect(error).toBeNull()
    expect(data?.length).toBeGreaterThan(0)
    expect(data?.every((r) => r.session_id === SESSION_ID)).toBe(true)
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
    // mercury/bluevine/novo all have rtp_supported: false — if the !inner
    // hint were missing (the historical bug class this repo already shipped
    // once, for accounting_integration_available), this filter would be a
    // silent no-op and they'd leak through here too.
    expect(slugs).not.toContain(KNOWN_SLUGS.mercury)
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
      expect(slugs).not.toContain('karat-business-checking') // apy_max 0.0175
      expect(slugs).not.toContain(KNOWN_SLUGS.grasshopper) // 0.0135
      expect(slugs).not.toContain('highbeam-business-checking') // 0.0132
    })

    it('apy_min also excludes NULL-apy_max listings (the !inner join restricts rows)', async () => {
      const results = await run({ apy_min: 0.0001 })
      const slugs = results.map((r) => r.listing_slug)
      // All 7 non-interest-bearing checking listings have NULL apy_max.
      for (const slug of [KNOWN_SLUGS.mercury, KNOWN_SLUGS.novo, KNOWN_SLUGS.chase, KNOWN_SLUGS.citibank]) {
        expect(slugs).not.toContain(slug)
      }
      expect(apyScoped(results).sort()).toEqual([...APY_SLUGS].sort())
    })

    it('apy_min above every seeded apy_max returns none of the seeded listings', async () => {
      const results = await run({ apy_min: 0.031 })
      expect(apyScoped(results)).toEqual([])
    })
  })

  it('monthly_fee ordering is stable across repeated calls against the same live dataset', async () => {
    const [first, second] = await Promise.all([run({}), run({})])
    expect(first.map((r) => r.listing_slug)).toEqual(second.map((r) => r.listing_slug))
  })
})
