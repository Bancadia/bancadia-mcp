import { vi } from 'vitest'
import * as RedisModule from '@upstash/redis'

export const TEST_SESSION_ID = 'test-session-id'
export const TEST_SESSION_RECORD = { protocolVersion: '2025-06-18', createdAt: 1700000000000 }

export function withSession(headers: Record<string, string> = {}) {
  return { 'Mcp-Session-Id': TEST_SESSION_ID, ...headers }
}

interface MockRedisOptions {
  /** What `token:*` keys resolve to (auth cache). Default `true` (valid, cache hit). `null` is a cache miss. */
  tokenValid?: boolean | null
  /** developerId carried in the cached token payload when `tokenValid` is true. */
  tokenDeveloperId?: string | null
  /** Whether `session:*` keys resolve to a valid record. Default `true`. */
  sessionValid?: boolean
  set?: ReturnType<typeof vi.fn>
  expire?: ReturnType<typeof vi.fn>
  del?: ReturnType<typeof vi.fn>
}

// Configures the module-level `Redis` mock (the test file must still declare
// `vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))` itself — vi.mock is
// hoisted per-file and can't be done from an imported helper) to serve both
// the auth-cache lookup (`token:<hash>`, src/lib/auth.ts) and the session
// lookup (`session:<id>`, src/lib/session.ts) from one instance, since both
// modules share the same Redis client.
export const TEST_DEVELOPER_ID = 'test-developer-id'

export function mockRedis(options: MockRedisOptions = {}) {
  const {
    tokenValid = true,
    tokenDeveloperId = TEST_DEVELOPER_ID,
    sessionValid = true,
    set = vi.fn().mockResolvedValue('OK'),
    expire = vi.fn().mockResolvedValue(1),
    del = vi.fn().mockResolvedValue(1),
  } = options

  const get = vi.fn().mockImplementation((key: string) => {
    if (key.startsWith('session:')) return Promise.resolve(sessionValid ? TEST_SESSION_RECORD : null)
    if (key.startsWith('token:')) {
      if (tokenValid === null) return Promise.resolve(null)
      return Promise.resolve({ valid: tokenValid, developerId: tokenValid ? tokenDeveloperId : null })
    }
    return Promise.resolve(null)
  })

  const instance = { get, set, expire, del }
  vi.mocked(RedisModule.Redis).mockImplementation(function () {
    return instance
  } as unknown as typeof RedisModule.Redis)

  return instance
}

// `from()` stub for handler tests that assert on analytics: query_events and
// query_match_events each get their own insert spy, every other table gets
// `queryChain`. recordQueryEvent inserts the query_events row first and only
// then the match rows, so `matchInsert` is only called after `eventInsert`.
export function mockAnalyticsTables(queryChain: unknown) {
  const eventInsert = vi.fn().mockResolvedValue({ data: null, error: null })
  const matchInsert = vi.fn().mockResolvedValue({ data: null, error: null })
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'query_events') return { insert: eventInsert }
    if (table === 'query_match_events') return { insert: matchInsert }
    return queryChain
  })
  return { from, eventInsert, matchInsert }
}
