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

describe('tools/list', () => {
  it('returns 200 with result containing a tools array', async () => {
    const request = post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ jsonrpc: string; result: { tools: unknown[] } }>()
    expect(body.jsonrpc).toBe('2.0')
    expect(Array.isArray(body.result.tools)).toBe(true)
  })

  it('tools array contains only query_business_checking', async () => {
    const request = post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { tools: Array<{ name: string }> } }>()
    const names = body.result.tools.map((t) => t.name)
    expect(names).toEqual(['query_business_checking'])
  })

  it('each tool has name, description, and inputSchema', async () => {
    const request = post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{
      result: { tools: Array<{ name: string; description: string; inputSchema: object }> }
    }>()
    for (const tool of body.result.tools) {
      expect(tool).toHaveProperty('name')
      expect(tool).toHaveProperty('description')
      expect(tool).toHaveProperty('inputSchema')
    }
  })
})
