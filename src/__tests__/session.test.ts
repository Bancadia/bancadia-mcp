import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

import app from '../index'
import * as RedisModule from '@upstash/redis'

function post(body: object, headers: Record<string, string> = {}) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function del(headers: Record<string, string> = {}) {
  return new Request('http://localhost/', { method: 'DELETE', headers })
}

// A stateful fake Redis store (as opposed to the shared canned mock in
// helpers.ts) so this file can exercise a real create -> validate -> touch
// -> delete -> re-validate lifecycle rather than per-call canned responses.
function makeStatefulRedis() {
  const store = new Map<string, unknown>()
  const get = vi.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key) : null))
  const set = vi.fn((key: string, value: unknown) => {
    store.set(key, value)
    return Promise.resolve('OK')
  })
  const expire = vi.fn((key: string) => Promise.resolve(store.has(key) ? 1 : 0))
  const del = vi.fn((key: string) => {
    const existed = store.has(key)
    store.delete(key)
    return Promise.resolve(existed ? 1 : 0)
  })
  const instance = { get, set, expire, del }
  vi.mocked(RedisModule.Redis).mockImplementation(function () {
    return instance
  } as unknown as typeof RedisModule.Redis)
  return instance
}

async function initializeSession(): Promise<string> {
  const request = post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const ctx = createExecutionContext()
  const response = await app.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  const sessionId = response.headers.get('Mcp-Session-Id')
  if (!sessionId) throw new Error('expected Mcp-Session-Id header on initialize response')
  return sessionId
}

describe('session lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('initialize issues a session id and persists a record for it with the configured TTL', async () => {
    const redis = makeStatefulRedis()
    const sessionId = await initializeSession()

    expect(sessionId).toBeTruthy()
    expect(redis.set).toHaveBeenCalledWith(
      `session:${sessionId}`,
      expect.objectContaining({ protocolVersion: expect.any(String) }),
      { ex: 1800 }
    )
  })

  it('rejects a request with no Mcp-Session-Id header with 400', async () => {
    makeStatefulRedis()
    const request = post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(400)
  })

  it('rejects a request with an unknown Mcp-Session-Id with 404', async () => {
    makeStatefulRedis()
    const request = post(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'Mcp-Session-Id': 'does-not-exist' }
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(404)
  })

  it('accepts a subsequent request carrying the issued session id, and refreshes its TTL', async () => {
    const redis = makeStatefulRedis()
    const sessionId = await initializeSession()

    const request = post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'Mcp-Session-Id': sessionId }
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(redis.expire).toHaveBeenCalledWith(`session:${sessionId}`, 1800)
  })

  it('DELETE terminates the session; a later request with that id then gets 404', async () => {
    makeStatefulRedis()
    const sessionId = await initializeSession()

    const deleteRequest = del({ 'Mcp-Session-Id': sessionId })
    const deleteCtx = createExecutionContext()
    const deleteResponse = await app.fetch(deleteRequest, env, deleteCtx)
    await waitOnExecutionContext(deleteCtx)
    expect(deleteResponse.status).toBe(204)

    const request = post(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { 'Mcp-Session-Id': sessionId }
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(404)
  })

  it('DELETE with an unknown session id is rejected with 404', async () => {
    makeStatefulRedis()
    const request = del({ 'Mcp-Session-Id': 'does-not-exist' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(404)
  })
})
