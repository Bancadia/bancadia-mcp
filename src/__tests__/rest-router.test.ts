import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))

const limitMock = vi.hoisted(() => vi.fn())
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: limitMock }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn() }))

import app from '../index'
import { createSupabaseClient } from '../lib/supabase'
import { mockRedis, mockAnalyticsTables, TEST_DEVELOPER_ID } from './helpers'

const listing = { listing_slug: 'found-business-checking', application_url: '/go/found/business-checking', institution_name: 'Found' }
const listData = {
  rows: [listing], total_matches: 1, returned: 1, limit: 7, next_offset: null, excluded_by: {},
  returned_ids: [{ id: 'l1', slug: 'found-business-checking', rank: 1 }],
}
const detailData = {
  listings: [{ slug: 'found-business-checking', application_url: '/go/found/business-checking', detail_has: ['tiers:1'] }],
  returned_ids: [{ id: 'l1', slug: 'found-business-checking', rank: 1 }],
}

async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`http://localhost${path}`, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

let tables: ReturnType<typeof mockAnalyticsTables>
// rpc answers every DB function with `data` (or `error`); analytics tables are recorded.
function setup(result: { data?: unknown; error?: unknown }, redis: Parameters<typeof mockRedis>[0] = {}) {
  mockRedis(redis)
  tables = mockAnalyticsTables({})
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  vi.mocked(createSupabaseClient).mockReturnValue({ rpc, from: tables.from } as never)
  return rpc
}

beforeEach(() => {
  vi.clearAllMocks()
  limitMock.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 30_000 })
})

describe('GET /v1/business-checking-listings', () => {
  it('returns the envelope, headers and tagged application_url (anonymous)', async () => {
    setup({ data: listData })
    const res = await call('/v1/business-checking-listings?monthly_fee_max=0', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    expect(res.status).toBe(200)
    const body = await res.json<{ data: { application_url: string }[]; meta: Record<string, unknown> }>()
    const rid = res.headers.get('X-Request-Id')!
    expect(body.meta).toMatchObject({ count: 1, request_id: rid, filters: { monthly_fee_max: 0 }, total_matches: 1, returned: 1, limit: 7, next_offset: null })
    expect(JSON.stringify(body)).not.toContain('returned_ids')
    const url = new URL(body.data[0]!.application_url)
    expect(url.searchParams.get('src')).toBe('rest')
    expect(url.searchParams.get('qr')).toBe(rid)

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(res.headers.get('Link')).toContain('rel="service-doc"')
    expect(res.headers.get('Link')).toContain('rel="service-desc"')
    expect(res.headers.get('RateLimit-Limit')).toBe('60')
    expect(res.headers.get('RateLimit-Remaining')).toBe('59')
    expect(Number(res.headers.get('RateLimit-Reset'))).toBeGreaterThan(0)
    expect(limitMock).toHaveBeenCalledWith('ip:1.2.3.4')

    expect(tables.eventInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'rest',
        session_id: null,
        developer_id: null,
        request_id: rid,
        tool_name: 'list_business_checking',
        profile: 'v2',
        status: 'ok',
      })
    )
  })

  it('credits a valid token and rate limits by token', async () => {
    setup({ data: listData })
    const res = await call('/v1/business-checking-listings', { headers: { Authorization: 'Bearer sk_test' } })
    expect(res.status).toBe(200)
    expect(limitMock).toHaveBeenCalledWith(expect.stringMatching(/^token:/))
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ developer_id: TEST_DEVELOPER_ID }))
  })

  it('400 problem+json on unknown param, and logs invalid_args', async () => {
    setup({})
    const res = await call('/v1/business-checking-listings?bogus=1')
    expect(res.status).toBe(400)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(await res.json()).toMatchObject({ status: 400, title: 'Bad Request', type: 'about:blank' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(tables.eventInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'invalid_args', channel: 'rest', session_id: null })
    )
  })

  it('400 when the DB rejects a bad enum (22023, message passed through)', async () => {
    setup({ error: { message: 'Unknown insurance type: nope. Valid insurance types: fdic, ncua, uninsured', code: '22023' } })
    const res = await call('/v1/business-checking-listings?insurance_type=nope')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ detail: expect.stringContaining('fdic, ncua') })
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid_args' }))
  })

  it('401 for an invalid token', async () => {
    setup({}, { tokenValid: false })
    const res = await call('/v1/business-checking-listings', { headers: { Authorization: 'Bearer bad' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('429 with Retry-After when rate limited', async () => {
    setup({})
    limitMock.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: Date.now() + 20_000 })
    const res = await call('/v1/business-checking-listings')
    expect(res.status).toBe(429)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(res.headers.get('RateLimit-Remaining')).toBe('0')
  })

  it('500 does not leak internals', async () => {
    setup({ error: { message: 'relation "secret_table" does not exist', code: '42P01' } })
    const res = await call('/v1/business-checking-listings')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('secret_table')
    expect(JSON.parse(text)).toMatchObject({ status: 500 })
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
  })
})

describe('GET /v1/business-checking-listings/:slug', () => {
  it('returns one object in the envelope', async () => {
    setup({ data: detailData })
    const res = await call('/v1/business-checking-listings/found-business-checking')
    expect(res.status).toBe(200)
    const body = await res.json<{ data: { slug: string; application_url: string }; meta: Record<string, unknown> }>()
    expect(Array.isArray(body.data)).toBe(false)
    expect(body.data.slug).toBe('found-business-checking')
    expect(body.meta).toMatchObject({ count: 1, request_id: res.headers.get('X-Request-Id') })
    expect(new URL(body.data.application_url).searchParams.get('src')).toBe('rest')
    expect(tables.eventInsert).toHaveBeenCalledWith(
      expect.objectContaining({ tool_name: 'get_listing', channel: 'rest', session_id: null })
    )
  })

  it('404 problem+json for an unknown slug', async () => {
    setup({ data: { listings: [], not_found: ['nope'], returned_ids: [] } })
    const res = await call('/v1/business-checking-listings/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', result_count: 0 }))
  })
})

describe('sub-resources, wildcard and deprecated aliases', () => {
  const sectionData = {
    listings: [{ slug: 'found-business-checking', application_url: '/go/found/business-checking', detail_has: ['fees:1'], fees: [{ fee_type: 'overdraft', plan: 'all plans', amount: 0 }] }],
    returned_ids: [{ id: 'l1', slug: 'found-business-checking', rank: 1 }],
  }

  it.each([['fees', 'fees'], ['features', 'features'], ['promotions', 'promotions'], ['plans', 'tiers']])('/%s calls get_listing with sections [%s]', async (route, section) => {
    const rpc = setup({ data: sectionData })
    const res = await call(`/v1/business-checking-listings/found-business-checking/${route}`)
    expect(res.status).toBe(200)
    expect(rpc.mock.calls[0]).toEqual(['get_listing_sections', { p_slugs: ['found-business-checking'], p_sections: [section] }])
    const body = await res.json<{ data: unknown[]; meta: { listing: { listing_slug: string; application_url: string }; count: number } }>()
    const rid = res.headers.get('X-Request-Id')!
    expect(body.meta.listing.listing_slug).toBe('found-business-checking')
    expect(body.meta.listing.application_url).toBe(`https://bancadia.com/go/found/business-checking?src=rest&qr=${rid}`)
    expect(body.data).toEqual(route === 'fees' ? sectionData.listings[0]!.fees : [])
    expect(body.meta.count).toBe(body.data.length)
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ tool_name: 'get_listing', channel: 'rest', profile: 'v2' }))
  })

  it('a sub-route rejects any query parameter with 400 before the DB', async () => {
    const rpc = setup({ data: sectionData })
    const res = await call('/v1/business-checking-listings/found-business-checking/fees?plan=x')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ detail: 'This route takes no query parameters.' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a sub-route for an unknown slug is 404', async () => {
    setup({ data: { listings: [], not_found: ['nope'], returned_ids: [] } })
    expect((await call('/v1/business-checking-listings/nope/fees')).status).toBe(404)
  })

  it.each(['', '/features', '/promotions', '/plans', '/fees', '/nope'])('wildcard: GET .../-%s is 404 for slug routes and never reaches the DB', async (suffix) => {
    const rpc = setup({ data: sectionData })
    const res = await call(`/v1/business-checking-listings/-${suffix}`)
    expect(res.status).toBe(suffix === '/fees' ? 400 : 404) // /-/fees is the fees_by_type route (fee_types required)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('/-/fees and /-/facts are the cross-listing routes', async () => {
    const rpc = setup({ data: { results: [], returned_ids: [] } })
    expect((await call('/v1/business-checking-listings/-/fees?fee_types=overdraft')).status).toBe(200)
    expect(rpc.mock.calls[0]![0]).toBe('fees_by_type')
    const rpc2 = setup({ data: { hits: [], scanned: 0, banks_matched: 0, returned_ids: [] } })
    expect((await call('/v1/business-checking-listings/-/facts?query=zelle')).status).toBe(200)
    expect(rpc2.mock.calls[0]![0]).toBe('search_listing_facts')
  })

  it('removed routes /compare, /facts and /fees no longer exist: under the alias they are just unknown slugs (404)', async () => {
    setup({ data: { listings: [], not_found: ['x'], returned_ids: [] } })
    for (const p of ['compare', 'facts', 'fees']) expect((await call(`/v1/business-checking/${p}`)).status).toBe(404)
  })

  it('deprecated aliases send Deprecation and successor-version Link and return the same body', async () => {
    setup({ data: listData })
    const [o, n] = [await call('/v1/business-checking?limit=1'), await call('/v1/business-checking-listings?limit=1')]
    expect(o.headers.get('Deprecation')).toBe('true')
    expect(o.headers.get('Link')).toContain('</v1/business-checking-listings>; rel="successor-version"')
    expect(o.headers.get('Link')).toContain('rel="service-doc"')
    expect(n.headers.get('Deprecation')).toBeNull()
    const strip = (t: string) => t.replace(/qr=[0-9a-f-]{36}/g, 'qr=X').replace(/"request_id":"[^"]+"/g, '"request_id":"X"')
    expect(strip(await o.text())).toBe(strip(await n.text()))

    setup({ data: detailData })
    const s = await call('/v1/business-checking/found-business-checking')
    expect(s.status).toBe(200)
    expect(s.headers.get('Deprecation')).toBe('true')
    expect(s.headers.get('Link')).toContain('</v1/business-checking-listings/found-business-checking>; rel="successor-version"')
  })
})

describe('misc', () => {
  it('answers CORS preflight', async () => {
    setup({})
    const res = await call('/v1/business-checking-listings', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
  })

  it('404 problem for unknown /v1 path', async () => {
    setup({})
    const res = await call('/v1/nothing')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
  })

  it('/.well-known/mcp advertises the REST API', async () => {
    const body = await (await call('/.well-known/mcp')).json<Record<string, unknown>>()
    expect(body.rest_api).toBe('https://api.bancadia.com/v1')
    expect(body.openapi).toBe('https://api.bancadia.com/v1/openapi.json')
  })
})
