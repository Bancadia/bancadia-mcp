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
import { setupDb, listPayload, listingPayload, type Json } from './v2-unit-helpers'
import { mockRedis } from './helpers'
import { TOOL_LIST } from '../chatgpt/tools'

beforeEach(() => vi.clearAllMocks())

const SESSION = '22222222-2222-4222-8222-222222222222'

async function rpc(method: string, params: Json = {}, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request('http://localhost/claude/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  return { res, body: (await res.json()) as Json }
}

describe('claude MCP surface', () => {
  it('initialize issues an Mcp-Session-Id', async () => {
    const redis = mockRedis({})
    const { res } = await rpc('initialize', { protocolVersion: '2025-06-18' })
    expect(res.headers.get('Mcp-Session-Id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(redis.set).toHaveBeenCalled()
  })

  it('tools/list reuses the chatgpt definitions without OpenAI-only _meta', async () => {
    mockRedis({})
    const { body } = await rpc('tools/list')
    const tools = body.result.tools as Json[]
    expect(tools.map((t) => t.name)).toEqual(TOOL_LIST.map((t) => t.name))
    for (const [i, t] of tools.entries()) {
      expect(t.annotations).toEqual(TOOL_LIST[i]!.annotations)
      expect(t.inputSchema).toEqual(TOOL_LIST[i]!.inputSchema)
      expect(Object.keys(t._meta).filter((k) => k.startsWith('openai/') || k === 'securitySchemes')).toEqual([])
    }
    expect(tools[0]._meta.ui.resourceUri).toBeTruthy()
  })

  it('list call: the rows are in the text block, channel=claude, echoed session is logged', async () => {
    mockRedis({})
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const { body } = await rpc('tools/call', { name: 'list_business_checking', arguments: {} }, { 'Mcp-Session-Id': SESSION })
    const text = body.result.content[0].text as string
    const json = JSON.parse(text.slice(text.indexOf('\n') + 1))
    expect(json.rows).toHaveLength(2)
    expect(json).toEqual(body.result.structuredContent)
    expect(text).toMatch(/fields in the data below/)
    expect(json.rows[0].application_url).toMatch(/[?&]src=claude&/)
    expect(db.eventInsert.mock.calls[0]![0]).toMatchObject({ channel: 'claude', session_id: SESSION })
  })

  it('serves the claude build of the widget; /chatgpt serves its own', async () => {
    mockRedis({})
    const read = async (path: string) => {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: TOOL_LIST[0]!._meta.ui.resourceUri } }) }),
        env,
        createExecutionContext()
      )
      return ((await res.json()) as Json).result.contents[0].text as string
    }
    expect(await read('/claude/mcp')).toContain("var HOST='claude'")
    expect(await read('/chatgpt/mcp')).toContain("var HOST='chatgpt'")
  })

  it('data tool call: data is in the text block too', async () => {
    mockRedis({})
    setupDb({ get_listing_sections: { data: listingPayload() } })
    const { body } = await rpc('tools/call', { name: 'get_listing', arguments: { slugs: ['a-bank'] } })
    expect(JSON.parse(body.result.content[0].text.split('\n').slice(1).join('\n'))).toEqual(body.result.structuredContent)
  })

  it.each([
    ['no session header', {}],
    ['an unknown or expired session id', { 'Mcp-Session-Id': SESSION }],
  ])('%s: the call still succeeds and logs session_id NULL', async (_n, headers) => {
    mockRedis({ sessionValid: false })
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const { res, body } = await rpc('tools/call', { name: 'list_business_checking', arguments: {} }, headers)
    expect(res.status).toBe(200)
    expect(body.result.structuredContent.rows).toHaveLength(2)
    expect(db.eventInsert.mock.calls[0]![0]).toMatchObject({ channel: 'claude', session_id: null })
  })

  it('ignores openai/session: no chat_conversation_id on this channel', async () => {
    mockRedis({})
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await rpc('tools/call', { name: 'list_business_checking', arguments: {}, _meta: { 'openai/session': 'x' } })
    expect(db.eventInsert.mock.calls[0]![0]).not.toHaveProperty('chat_conversation_id')
  })
})

describe('chatgpt surface is unchanged by the shared factory', () => {
  it('initialize sets no session header', async () => {
    mockRedis({})
    const res = await app.fetch(
      new Request('http://localhost/chatgpt/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }),
      env,
      createExecutionContext()
    )
    expect(res.headers.get('Mcp-Session-Id')).toBeNull()
  })
})
