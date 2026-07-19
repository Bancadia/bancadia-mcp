import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

import app from '../index'
import { mockRedis, withSession } from './helpers'

function post(body: object, headers: Record<string, string> = {}) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('initialize', () => {
  beforeEach(() => {
    mockRedis()
  })

  it('returns 200 with protocolVersion, capabilities, and serverInfo, no auth required', async () => {
    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{
      jsonrpc: string
      id: number
      result: {
        protocolVersion: string
        capabilities: { tools?: object }
        serverInfo: { name: string; version: string }
      }
    }>()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe(1)
    expect(body.result.protocolVersion).toBe('2025-06-18')
    expect(body.result.capabilities).toHaveProperty('tools')
    expect(body.result.serverInfo).toEqual({ name: 'Bancadia MCP', version: '2.0.0' })
  })

  it('issues an Mcp-Session-Id header on the response', async () => {
    const request = post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('Mcp-Session-Id')).toBeTruthy()
  })

  it('falls back to the latest supported protocol version when the client requests an unknown one', async () => {
    const request = post({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01', capabilities: {} },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { protocolVersion: string } }>()
    expect(body.result.protocolVersion).toBe('2025-06-18')
  })

  it('does not require an Authorization header', async () => {
    const request = post({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
  })
})

describe('JSON-RPC notifications', () => {
  beforeEach(() => {
    mockRedis()
  })

  it('notifications/initialized returns an empty 202 with no JSON-RPC envelope', async () => {
    const request = post({ jsonrpc: '2.0', method: 'notifications/initialized' }, withSession())
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(202)
    const text = await response.text()
    expect(text).toBe('')
  })

  it('any id-less request is treated as a notification, regardless of method name', async () => {
    const request = post(
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
      withSession()
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(202)
  })

  it('a notification without a session id is rejected with 400', async () => {
    const request = post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(400)
  })
})
