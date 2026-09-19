import { describe, it, expect, vi, beforeAll } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

// No vi.mock('../../lib/supabase') — exercises the real Supabase fallback
// path inside authenticate() (src/lib/auth.ts).

import { authenticate } from '../../lib/auth'
import { mockRedis } from '../helpers'
import type { Env } from '../../types'

// Mirrored in scripts/db/seed-test-fixtures.mjs — keep the raw token
// strings and fixed developer_id in sync if either changes.
const VALID_TOKEN = 'mcp_integration_test_token_do_not_use_in_prod'
const REVOKED_TOKEN = 'mcp_integration_test_revoked_token'
const FIXTURE_DEVELOPER_ID = 'b0000000-0000-0000-0000-000000000001'

function req(token: string) {
  return new Request('http://localhost/', { headers: { Authorization: `Bearer ${token}` } })
}

describe('authenticate — real Supabase fallback (Redis forced to cache-miss)', () => {
  beforeAll(() => {
    // tokenValid: null makes mockRedis's get() resolve null for token:*
    // keys, forcing authenticate() past the Redis cache and into the real
    // Supabase developer_api_tokens lookup — the path this file exists to
    // exercise. See scripts/db/seed-test-fixtures.mjs for the fixture rows.
    mockRedis({ tokenValid: null })
  })

  it('resolves a valid, non-revoked seeded token to the fixture developer', async () => {
    const ctx = createExecutionContext()
    const result = await authenticate(req(VALID_TOKEN), env as Env, ctx)
    expect(result.valid).toBe(true)
    expect(result.developerId).toBe(FIXTURE_DEVELOPER_ID)
  })

  it('rejects a revoked seeded token', async () => {
    const ctx = createExecutionContext()
    const result = await authenticate(req(REVOKED_TOKEN), env as Env, ctx)
    expect(result.valid).toBe(false)
    expect(result.developerId).toBeNull()
  })

  it('rejects an unknown token', async () => {
    const ctx = createExecutionContext()
    const result = await authenticate(req('sk_totally_unknown_token'), env as Env, ctx)
    expect(result.valid).toBe(false)
    expect(result.developerId).toBeNull()
  })
})
