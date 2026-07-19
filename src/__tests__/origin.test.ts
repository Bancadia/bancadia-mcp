import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

import app from '../index'
import { mockRedis } from './helpers'

function post(body: object, headers: Record<string, string> = {}) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('Origin validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis()
  })

  it('allows a request with no Origin header', async () => {
    const request = post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
  })

  it('allows a request whose Origin is in the ALLOWED_ORIGINS allowlist', async () => {
    const request = post(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { Origin: 'https://bancadia.com' }
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
  })

  it('rejects a request whose Origin is not in the allowlist with 403', async () => {
    const request = post(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { Origin: 'https://evil.example.com' }
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(403)
  })
})
