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

function chainOf(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'is', 'limit', 'contains', 'in', 'single', 'maybeSingle'])
    chain[m] = vi.fn().mockReturnValue(chain)
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

const listing = {
  id: 'l1',
  institution_id: 'i1',
  listing_slug: 'found-business-checking',
  product_name: 'Found',
  monthly_fee: 0,
  application_url: '/go/found/business-checking',
  listing_status: 'active',
  entity_types_accepted: ['llc'],
  available_states: ['ALL'],
  institutions: { name: 'Found', display_name: 'Found' },
  business_checking_details: {},
  business_deposit_plan_tiers: [],
  business_deposit_promotions: [],
  business_deposit_fees: [],
  business_deposit_account_features: [],
}

async function call(path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`http://localhost${path}`, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

let tables: ReturnType<typeof mockAnalyticsTables>
function setup(result: { data: unknown; error: unknown }, redis: Parameters<typeof mockRedis>[0] = {}) {
  mockRedis(redis)
  tables = mockAnalyticsTables(chainOf(result))
  vi.mocked(createSupabaseClient).mockReturnValue({ from: tables.from } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  limitMock.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 30_000 })
})

describe('GET /v1/business-checking', () => {
  it('returns the envelope, headers and tagged application_url (anonymous)', async () => {
    setup({ data: [listing], error: null })
    const res = await call('/v1/business-checking?monthly_fee_max=0', { headers: { 'CF-Connecting-IP': '1.2.3.4' } })
    expect(res.status).toBe(200)
    const body = await res.json<{ data: { application_url: string }[]; meta: Record<string, unknown> }>()
    const rid = res.headers.get('X-Request-Id')!
    expect(body.meta).toEqual({ count: 1, request_id: rid, filters: { monthly_fee_max: 0 } })
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
        tool_name: 'query_business_checking',
        status: 'ok',
      })
    )
  })

  it('credits a valid token and rate limits by token', async () => {
    setup({ data: [listing], error: null })
    const res = await call('/v1/business-checking', { headers: { Authorization: 'Bearer sk_test' } })
    expect(res.status).toBe(200)
    expect(limitMock).toHaveBeenCalledWith(expect.stringMatching(/^token:/))
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ developer_id: TEST_DEVELOPER_ID }))
  })

  it('400 problem+json on unknown param, and logs invalid_args', async () => {
    setup({ data: [], error: null })
    const res = await call('/v1/business-checking?bogus=1')
    expect(res.status).toBe(400)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(await res.json()).toMatchObject({ status: 400, title: 'Bad Request', type: 'about:blank' })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(tables.eventInsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'invalid_args', channel: 'rest', session_id: null })
    )
  })

  it('400 when validateArgs rejects (bad enum)', async () => {
    setup({ data: [], error: null })
    const res = await call('/v1/business-checking?insurance_type=nope')
    expect(res.status).toBe(400)
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid_args' }))
  })

  it('401 for an invalid token', async () => {
    setup({ data: [], error: null }, { tokenValid: false })
    const res = await call('/v1/business-checking', { headers: { Authorization: 'Bearer bad' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
  })

  it('429 with Retry-After when rate limited', async () => {
    setup({ data: [], error: null })
    limitMock.mockResolvedValue({ success: false, limit: 60, remaining: 0, reset: Date.now() + 20_000 })
    const res = await call('/v1/business-checking')
    expect(res.status).toBe(429)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(res.headers.get('RateLimit-Remaining')).toBe('0')
  })

  it('500 does not leak internals', async () => {
    setup({ data: null, error: { message: 'relation "secret_table" does not exist' } })
    const res = await call('/v1/business-checking')
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('secret_table')
    expect(JSON.parse(text)).toMatchObject({ status: 500 })
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
  })
})

describe('GET /v1/business-checking/:slug', () => {
  it('returns one object in the envelope', async () => {
    setup({ data: [listing], error: null })
    const res = await call('/v1/business-checking/found-business-checking')
    expect(res.status).toBe(200)
    const body = await res.json<{ data: { listing_slug: string; application_url: string }; meta: Record<string, unknown> }>()
    expect(Array.isArray(body.data)).toBe(false)
    expect(body.data.listing_slug).toBe('found-business-checking')
    expect(body.meta).toEqual({ count: 1, request_id: res.headers.get('X-Request-Id') })
    expect(new URL(body.data.application_url).searchParams.get('src')).toBe('rest')
    expect(tables.eventInsert).toHaveBeenCalledWith(
      expect.objectContaining({ tool_name: 'get_business_checking_listing', channel: 'rest', session_id: null })
    )
  })

  it('404 problem+json for an unknown slug', async () => {
    setup({ data: [], error: null })
    const res = await call('/v1/business-checking/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(tables.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', result_count: 0 }))
  })
})

describe('misc', () => {
  it('answers CORS preflight', async () => {
    setup({ data: [], error: null })
    const res = await call('/v1/business-checking', {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET')
  })

  it('404 problem for unknown /v1 path', async () => {
    setup({ data: [], error: null })
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
