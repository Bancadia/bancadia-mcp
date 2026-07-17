import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

// Mocks must be at the top level (hoisted by vitest).
// Redis constructor must use function keyword — arrow functions are not new-able.
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(function () {
    return {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    }
  }),
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

vi.mock('../lib/supabase', () => ({
  createSupabaseClient: vi.fn(),
}))

import app from '../index'
import * as RedisModule from '@upstash/redis'
import { createSupabaseClient } from '../lib/supabase'

function post(body: object, headers: Record<string, string> = {}) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const toolsCallBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'query_business_checking', arguments: {} },
}

// Build a Supabase chain that handles both:
// - auth token lookup (.select().eq().is().single())
// - query handler chaining (.select().eq().order().gte()/.lte() then thenable)
function makeSupabaseChain(
  singleResult = { data: { token_hash: 'valid' }, error: null },
  queryData: unknown[] = []
) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'is']
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain)
  chain['single'] = vi.fn().mockResolvedValue(singleResult)
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: queryData, error: null }).then(resolve)
  return chain
}

// Set up Redis mock so it's a proper constructor
function makeRedisInstance(
  overrides: { get?: ReturnType<typeof vi.fn>; set?: ReturnType<typeof vi.fn> } = {}
) {
  const get = overrides.get ?? vi.fn().mockResolvedValue(null)
  const set = overrides.set ?? vi.fn().mockResolvedValue('OK')
  const instance = { get, set }
  vi.mocked(RedisModule.Redis).mockImplementation(function () {
    return instance
  } as unknown as typeof RedisModule.Redis)
  return instance
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: cache miss, DB returns valid token, query returns empty results
    makeRedisInstance()

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockImplementation(() => makeSupabaseChain()),
    } as unknown as ReturnType<typeof createSupabaseClient>)
  })

  it('returns 401 when Authorization header is missing', async () => {
    const request = post(toolsCallBody)
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
    const body = await response.json<{ error: { code: number } }>()
    expect(body.error.code).toBe(-32001)
  })

  it('returns 401 when Authorization is malformed (no Bearer prefix)', async () => {
    const request = post(toolsCallBody, { Authorization: 'Token abc123' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
    const body = await response.json<{ error: { code: number } }>()
    expect(body.error.code).toBe(-32001)
  })

  it('returns 200 when token is valid (cache hit true)', async () => {
    makeRedisInstance({ get: vi.fn().mockResolvedValue(true) })

    const request = post(toolsCallBody, { Authorization: 'Bearer sk_valid_token' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
  })

  it('returns 401 when token is invalid (cache hit false)', async () => {
    makeRedisInstance({ get: vi.fn().mockResolvedValue(false) })

    const request = post(toolsCallBody, { Authorization: 'Bearer sk_invalid_token' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
  })

  it('returns 200 on cache miss with valid DB token, and Redis set is called', async () => {
    const setMock = vi.fn().mockResolvedValue('OK')
    makeRedisInstance({ get: vi.fn().mockResolvedValue(null), set: setMock })

    const request = post(toolsCallBody, { Authorization: 'Bearer sk_valid_token' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(setMock).toHaveBeenCalledWith(
      expect.stringMatching(/^token:/),
      true,
      { ex: 60 }
    )
  })
})
