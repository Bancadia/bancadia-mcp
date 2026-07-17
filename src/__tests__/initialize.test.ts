import { describe, it, expect } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import app from '../index'

function post(body: object) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('initialize', () => {
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
  it('notifications/initialized returns an empty 202 with no JSON-RPC envelope', async () => {
    const request = post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(202)
    const text = await response.text()
    expect(text).toBe('')
  })

  it('any id-less request is treated as a notification, regardless of method name', async () => {
    const request = post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(202)
  })
})
