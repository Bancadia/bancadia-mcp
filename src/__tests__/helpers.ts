import { vi } from 'vitest'
import * as RedisModule from '@upstash/redis'

export const TEST_SESSION_ID = 'test-session-id'
export const TEST_SESSION_RECORD = { protocolVersion: '2025-06-18', createdAt: 1700000000000 }

export function withSession(headers: Record<string, string> = {}) {
  return { 'Mcp-Session-Id': TEST_SESSION_ID, ...headers }
}

interface MockRedisOptions {
  /** What `token:*` keys resolve to (auth cache). Default `true` (valid, cache hit). */
  tokenValid?: boolean | null
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
export function mockRedis(options: MockRedisOptions = {}) {
  const {
    tokenValid = true,
    sessionValid = true,
    set = vi.fn().mockResolvedValue('OK'),
    expire = vi.fn().mockResolvedValue(1),
    del = vi.fn().mockResolvedValue(1),
  } = options

  const get = vi.fn().mockImplementation((key: string) => {
    if (key.startsWith('session:')) return Promise.resolve(sessionValid ? TEST_SESSION_RECORD : null)
    if (key.startsWith('token:')) return Promise.resolve(tokenValid)
    return Promise.resolve(null)
  })

  const instance = { get, set, expire, del }
  vi.mocked(RedisModule.Redis).mockImplementation(function () {
    return instance
  } as unknown as typeof RedisModule.Redis)

  return instance
}
