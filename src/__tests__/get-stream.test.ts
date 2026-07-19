import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

import app from '../index'
import { mockRedis, withSession } from './helpers'

function get(headers: Record<string, string> = {}) {
  return new Request('http://localhost/', { method: 'GET', headers })
}

describe('GET standalone SSE stream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens a text/event-stream and sends at least one keep-alive ping', async () => {
    mockRedis()
    const request = get({ Accept: 'text/event-stream', ...withSession() })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toContain('event: ping')

    await reader.cancel()
  })

  it('returns 405 when Accept does not include text/event-stream', async () => {
    mockRedis()
    const request = get(withSession())
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(405)
  })

  it('returns 400 when the Mcp-Session-Id header is missing', async () => {
    mockRedis()
    const request = get({ Accept: 'text/event-stream' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(400)
  })

  it('returns 404 when the Mcp-Session-Id is unknown', async () => {
    mockRedis({ sessionValid: false })
    const request = get({ Accept: 'text/event-stream', ...withSession() })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(404)
  })
})
