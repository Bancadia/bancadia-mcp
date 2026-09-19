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

// No vi.mock('../../lib/supabase') — real local Supabase instance.

import app from '../../index'
import { mockRedis, withSession } from '../helpers'
import { KNOWN_SLUGS, EXPECTED } from './fixtures'
import { realSupabase, lookupListingIdBySlug } from './db-helpers'

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

async function getListing(listingSlug: string) {
  const request = post({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_business_checking_listing', arguments: { listing_slug: listingSlug } },
  })
  const ctx = createExecutionContext()
  const response = await app.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
  return JSON.parse(body.result.content[0].text) as Array<Record<string, unknown>>
}

describe('get_business_checking_listing — real local Supabase', () => {
  beforeAll(() => {
    mockRedis({ tokenValid: true, tokenDeveloperId: null })
  })

  it('resolves a known listing by slug with the expected shape', async () => {
    const [listing] = await getListing(KNOWN_SLUGS.mercury)
    expect(listing).toBeDefined()
    expect(listing).toMatchObject(EXPECTED[KNOWN_SLUGS.mercury])
  })

  it('returns [] for an unknown slug', async () => {
    const results = await getListing('not-a-real-listing-slug')
    expect(results).toEqual([])
  })

  it('extracted listing_id is a real, queryable FK target for child tables', async () => {
    const realId = await lookupListingIdBySlug(KNOWN_SLUGS.mercury)
    const { data, error } = await realSupabase()
      .from('business_deposit_accounts')
      .select('id')
      .eq('id', realId)
      .single()
    expect(error).toBeNull()
    expect(data?.id).toBe(realId)
  })

  it('target_industries/target_business_profiles are present and empty for unseeded data, proving the embed is not accidentally !inner-joined', async () => {
    // No onboarding-script listing has seeded
    // business_deposit_account_target_segments rows. If TARGET_SEGMENTS_EMBED
    // were missing from the select string, these fields would be absent
    // entirely; if it were accidentally `!inner`-joined, this whole query
    // would return [] instead of the listing.
    const [listing] = await getListing(KNOWN_SLUGS.mercury)
    expect(listing.target_industries).toEqual([])
    expect(listing.target_business_profiles).toEqual([])
  })

  it('records a query_match_events row scoped to this test session on a match', async () => {
    await getListing(KNOWN_SLUGS.bluevine)
    const { data, error } = await realSupabase()
      .from('query_match_events')
      .select('listing_slug, session_id')
      .eq('session_id', SESSION_ID)
      .eq('listing_slug', KNOWN_SLUGS.bluevine)
    expect(error).toBeNull()
    expect(data?.length).toBeGreaterThan(0)
  })
})
