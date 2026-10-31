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

  it('returns exactly the listing\'s DB segments, bucketed by category', async () => {
    const id = await lookupListingIdBySlug(KNOWN_SLUGS.mercury)
    const { data, error } = await realSupabase().from('business_deposit_account_target_segments').select('category, segment').eq('listing_id', id)
    expect(error).toBeNull()
    const segs = (data ?? []) as Array<{ category: string; segment: string }>
    const of = (category: string) => segs.filter((s) => s.category === category).map((s) => s.segment).sort()
    const [listing] = await getListing(KNOWN_SLUGS.mercury)
    expect([...(listing.target_industries as string[])].sort()).toEqual(of('industry_vertical'))
    expect([...(listing.target_business_profiles as string[])].sort()).toEqual(of('business_profile'))
  })

  it('a listing with no segment rows still returns, with empty arrays (embed is not !inner-joined)', async (ctx) => {
    // If TARGET_SEGMENTS_EMBED were missing, the fields would be absent; if it were `!inner`, the query would return [].
    const db = realSupabase()
    const [{ data: accounts }, { data: tagged }] = await Promise.all([
      db.from('business_deposit_accounts').select('listing_slug, id').eq('listing_status', 'active').eq('product_type', 'checking'),
      db.from('business_deposit_account_target_segments').select('listing_id'),
    ])
    const taggedIds = new Set((tagged ?? []).map((t) => t.listing_id))
    const untagged = (accounts ?? []).find((a) => !taggedIds.has(a.id))
    if (!untagged) return ctx.skip('every active checking listing has segment rows in this database')
    const [listing] = await getListing(untagged.listing_slug)
    expect(listing, untagged.listing_slug).toBeDefined()
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
