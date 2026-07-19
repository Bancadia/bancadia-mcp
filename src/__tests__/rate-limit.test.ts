import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

// Mocks must be at the top level (hoisted by vitest).
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

// Default: within limit. Individual tests override via mockImplementation.
const mockLimit = vi.fn().mockResolvedValue({
  success: true,
  limit: 100,
  remaining: 99,
  reset: 1700000060000, // fixed ms timestamp → 1700000060 Unix seconds
})

vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: mockLimit }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

vi.mock('../lib/supabase', () => ({
  createSupabaseClient: vi.fn(),
}))

import app from '../index'
import { createSupabaseClient } from '../lib/supabase'
import { mockRedis, withSession } from './helpers'

function post(body: object, headers: Record<string, string> = {}) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withSession(headers) },
    body: JSON.stringify(body),
  })
}

const toolsCallBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'query_business_checking', arguments: {} },
}

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

describe('rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Default: cache hit (token valid), session valid, supabase returns valid token
    mockRedis()

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockImplementation(() => makeSupabaseChain()),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    // Reset to within-limit default
    mockLimit.mockResolvedValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: 1700000060000,
    })
  })

  it('returns 200 with X-RateLimit-* headers when within limit', async () => {
    const request = post(toolsCallBody, { Authorization: 'Bearer sk_valid_token' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('X-RateLimit-Limit')).toBe('100')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('99')
    expect(response.headers.get('X-RateLimit-Reset')).toBe('1700000060')
  })

  it('returns 429 with X-RateLimit-* headers and error body when over limit', async () => {
    const resetMs = 1700000060000
    mockLimit.mockResolvedValue({
      success: false,
      limit: 100,
      remaining: 0,
      reset: resetMs,
    })

    const request = post(toolsCallBody, { Authorization: 'Bearer sk_valid_token' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(429)
    expect(response.headers.get('X-RateLimit-Limit')).toBe('100')
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(response.headers.get('X-RateLimit-Reset')).toBe('1700000060')

    const body = await response.json<{ error: { code: number; message: string } }>()
    expect(body.error.code).toBe(-32029)
    expect(body.error.message).toBe('Rate limit exceeded.')
  })

  it('returns 401 without any X-RateLimit-* headers when unauthenticated', async () => {
    // No Authorization header, but a valid session
    const request = post(toolsCallBody)
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
    expect(response.headers.get('X-RateLimit-Limit')).toBeNull()
    expect(response.headers.get('X-RateLimit-Remaining')).toBeNull()
    expect(response.headers.get('X-RateLimit-Reset')).toBeNull()
  })

  it('does not consume quota on 401 (rate limiter not called)', async () => {
    // Invalid token: cache hit returns false; session remains valid
    mockRedis({ tokenValid: false })

    const request = post(toolsCallBody, { Authorization: 'Bearer sk_invalid_token' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
    expect(mockLimit).not.toHaveBeenCalled()
    expect(response.headers.get('X-RateLimit-Limit')).toBeNull()
  })
})
