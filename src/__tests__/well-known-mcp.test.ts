import { describe, it, expect } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import app from '../index'

describe('GET /.well-known/mcp', () => {
  it('returns 200 with required discovery fields', async () => {
    const request = new Request('http://localhost/.well-known/mcp')
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<Record<string, unknown>>()
    expect(body).toHaveProperty('name')
    expect(body).toHaveProperty('version')
    expect(body).toHaveProperty('endpoint')
  })

  it('returns correct endpoint URL', async () => {
    const request = new Request('http://localhost/.well-known/mcp')
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<Record<string, unknown>>()
    expect(body.endpoint).toBe('https://mcp.bancadia.com')
  })
})
