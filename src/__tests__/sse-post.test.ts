import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return {
      limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }),
    }
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
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...withSession(headers),
    },
    body: JSON.stringify(body),
  })
}

function makeSupabaseChain(queryData: unknown[] = []) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'is']
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain)
  chain['then'] = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: queryData, error: null }).then(resolve)
  return chain
}

// SSE frames look like `event: message\ndata: <json>\n\n`. Only the first
// frame is relevant here since our handlers write exactly one message event
// and close.
async function parseSseMessage(response: Response) {
  const text = await response.text()
  const frame = text.split('\n\n')[0]
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
  return JSON.parse(dataLines.join('\n')) as {
    jsonrpc: string
    id: unknown
    result?: unknown
    error?: unknown
  }
}

describe('POST response mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis()
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(makeSupabaseChain()),
    } as unknown as ReturnType<typeof createSupabaseClient>)
  })

  it('tools/list responds with text/event-stream and the JSON-RPC result as the final event', async () => {
    const request = post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')

    const message = await parseSseMessage(response)
    expect(message.jsonrpc).toBe('2.0')
    expect(message.id).toBe(1)
    expect(message.result).toHaveProperty('tools')
  })

  it('tools/call responds with text/event-stream carrying the tool result', async () => {
    const request = post(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'query_business_checking', arguments: {} } },
      { Authorization: 'Bearer sk_test_token' }
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')

    const message = await parseSseMessage(response)
    expect(message.jsonrpc).toBe('2.0')
    expect(message.id).toBe(2)
    expect(message.result).toHaveProperty('content')
  })

  it('falls back to plain application/json when Accept does not include text/event-stream', async () => {
    const request = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...withSession() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    const body = await response.json<{ result: { tools: unknown[] } }>()
    expect(Array.isArray(body.result.tools)).toBe(true)
  })

  it('HTTP-level errors (e.g. unauthorized tools/call) stay plain JSON even when SSE is accepted', async () => {
    mockRedis({ tokenValid: false })
    const request = post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'query_business_checking', arguments: {} } },
      { Authorization: 'Bearer sk_invalid_token' }
    )
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(401)
    expect(response.headers.get('Content-Type')).toContain('application/json')
  })
})
