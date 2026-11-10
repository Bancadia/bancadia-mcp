import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }) }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})
vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn() }))

import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import app from '../index'
import { setupDb, callMcp, listPayload, type Json } from './v2-unit-helpers'
import { TOOLS_V2 } from '../lib/tools-v2'

beforeEach(() => vi.clearAllMocks())

async function rpc(method: string, params: Json = {}, init: RequestInit = {}) {
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request('http://localhost/chatgpt/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      ...init,
    }),
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return { status: res.status, body: (await res.json()) as Json }
}

describe('chatgpt MCP surface', () => {
  it('initialize needs no session header and advertises tools + resources', async () => {
    const { status, body } = await rpc('initialize', { protocolVersion: '2025-06-18' })
    expect(status).toBe(200)
    expect(body.result.capabilities).toEqual({ tools: {}, resources: {} })
  })

  it('notifications get 202 with no body', async () => {
    const res = await app.fetch(
      new Request('http://localhost/chatgpt/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
      env,
      createExecutionContext()
    )
    expect(res.status).toBe(202)
  })

  it('tools/list: read-only annotations, widget template, full v2 filter set, limit capped at 8', async () => {
    const { body } = await rpc('tools/list')
    const [tool] = body.result.tools
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    expect(tool._meta.ui.resourceUri).toBe(tool._meta['openai/outputTemplate'])
    expect(tool.outputSchema).toBeTruthy()
    const v2 = TOOLS_V2.find((t) => t.name === 'list_business_checking')!.inputSchema.properties as Json
    const { limit: _l, ...v2Rest } = v2
    const { limit, ...rest } = tool.inputSchema.properties
    expect(rest).toEqual(v2Rest) // no filter dropped, none changed
    expect(limit.maximum).toBe(8)
    expect(tool.description).toMatch(/ONLY values in the returned data/)
  })

  it('resources/read serves the widget as mcp-app html; unknown uri errors', async () => {
    const { body: list } = await rpc('resources/list')
    const uri = list.result.resources[0].uri
    const { body } = await rpc('resources/read', { uri })
    expect(body.result.contents[0].mimeType).toBe('text/html;profile=mcp-app')
    expect(body.result.contents[0].text).toMatch(/<!doctype html>/)
    const missing = await rpc('resources/read', { uri: 'ui://nope' })
    expect(missing.body.error.code).toBe(-32002)
  })

  it('tools/call: defaults limit to 4, always requests card fields, returns structuredContent, logs channel=chatgpt without a session', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const { body } = await rpc('tools/call', { name: 'search_business_checking', arguments: { monthly_fee_max: 0, fields: ['apy_tiers'] } })
    const call = db.rpc.mock.calls[0]!
    expect(call[1].p_limit).toBe(4)
    expect(call[1].p_fields).toEqual(expect.arrayContaining(['monthly_fee', 'last_verified', 'product_name', 'apy_tiers']))
    expect(body.result.structuredContent.rows).toHaveLength(2)
    expect(body.result.structuredContent.hint).toBeUndefined()
    expect(body.result.structuredContent.rows[0].application_url).toMatch(/^https:\/\/bancadia\.com\/go\/.*[?&]src=chatgpt&/)
    expect(body.result.content[0].text).toMatch(/do not restate the table/)
    expect(db.eventInsert.mock.calls[0]![0]).toMatchObject({ channel: 'chatgpt', session_id: null, tool_name: 'list_business_checking' })
  })

  it('tools/call: limit is clamped to 8', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await rpc('tools/call', { name: 'search_business_checking', arguments: { limit: 20 } })
    expect(db.rpc.mock.calls[0]![1].p_limit).toBe(8)
  })

  it('tools/call: invalid args come back as an isError result, not a transport error', async () => {
    setupDb({ list_business_checking: { data: listPayload() } })
    const { body } = await rpc('tools/call', { name: 'search_business_checking', arguments: { monthly_fee_max: 'free' } })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/monthly_fee_max/)
  })

  it('does not disturb the existing endpoint', async () => {
    setupDb({ list_business_checking: { data: listPayload() } })
    const r = await callMcp('list_business_checking', {})
    expect(r.ok).toBe(true)
  })
})
