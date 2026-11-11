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
import { setupDb, callMcp, listPayload, listingPayload, factsPayload, feesPayload, type Json } from './v2-unit-helpers'
import { TOOLS_V2 } from '../lib/tools-v2'
import { WIDGET_HTML } from '../chatgpt/widget'
import { LISTING_SLUGS } from '../chatgpt/tools'

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

  it('tools/list: read-only annotations, widget template, full v2 filter set, limit capped at 5', async () => {
    const { body } = await rpc('tools/list')
    const [tool] = body.result.tools
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    expect(tool._meta.ui.resourceUri).toBe(tool._meta['openai/outputTemplate'])
    expect(tool.outputSchema).toBeTruthy()
    const v2 = TOOLS_V2.find((t) => t.name === 'list_business_checking')!.inputSchema.properties as Json
    const { limit: _l, ...v2Rest } = v2
    const { limit, ...rest } = tool.inputSchema.properties
    expect(rest).toEqual(v2Rest) // no filter dropped, none changed
    expect(limit.maximum).toBe(5)
    expect(limit.description).toMatch(/Omit unless the user asks for fewer \(default 5, max 5\)/)
    expect(tool.description).toMatch(/ONLY values in the returned data/)
    expect(tool.description).toMatch(/never percentages/)
    expect(tool.description).toMatch(/never list or restate the cards, and never write or repeat application_url/i)
    expect(tool.description).toMatch(/call get_listing with that account's listing_slug in slugs/)
    expect(tool.description).not.toMatch(/\$\{/) // no un-interpolated template text
  })

  // The closing-question behavior (ChatGPT's own clickable questions) broke when the prompt prescribed
  // how to ask; keep the prompt silent about asking questions.
  it('tool text does not prescribe closing questions', async () => {
    const { body } = await rpc('tools/list')
    for (const t of body.result.tools) expect(t.description).not.toMatch(/question|pick a winner|offered as choices/i)
    setupDb({ list_business_checking: { data: listPayload() } })
    const call = await rpc('tools/call', { name: 'list_business_checking', arguments: {} })
    expect(call.body.result.content[0].text).not.toMatch(/question|pick a winner/i)
  })

  it('widget: horizontal carousel of every returned row, green Learn More that asks the model, no link', () => {
    expect(WIDGET_HTML).toContain('overflow-x:auto')
    expect(WIDGET_HTML).toContain('rows.forEach(function(r){root.appendChild(card(r));})') // no slice, no expander
    expect(WIDGET_HTML).not.toMatch(/Show \d|aria-expanded|Show more/)
    expect(WIDGET_HTML).toContain("'Learn More'")
    expect(WIDGET_HTML).toContain('--accent:#4ebe7a') // Bancadia logo green; dark button text (white is 2.3:1 on it, fails WCAG AA)
    expect(WIDGET_HTML).toContain('color:var(--on-accent)')
    expect(WIDGET_HTML).toContain('sendFollowUpMessage')
    expect(WIDGET_HTML).not.toContain('openExternal')
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

  it('tools/call: defaults limit to 5, always requests card fields, returns structuredContent, logs channel=chatgpt without a session', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const { body } = await rpc('tools/call', { name: 'list_business_checking', arguments: { monthly_fee_max: 0, fields: ['apy_tiers'] } })
    const call = db.rpc.mock.calls[0]!
    expect(call[1].p_limit).toBe(5)
    expect(call[1].p_fields).toEqual(expect.arrayContaining(['monthly_fee', 'last_verified', 'product_name', 'apy_tiers']))
    expect(body.result.structuredContent.rows).toHaveLength(2)
    expect(body.result.structuredContent.hint).toBeUndefined()
    expect(body.result.structuredContent.rows[0].monthly_fee_display).toBeUndefined() // fixture row has no fee: nothing invented
    expect(body.result.structuredContent.rows[0].application_url).toMatch(/^https:\/\/bancadia\.com\/go\/.*[?&]src=chatgpt&/)
    expect(body.result.content[0].text).toMatch(/Do not list or restate the cards or write any links/)
    expect(call[1].p_fields).toEqual(expect.arrayContaining(['apy_default', 'deposit_insurance_extended', 'cash_deposit_available', 'outgoing_domestic_wire_fee'])) // card + model-context fields
    expect(db.eventInsert.mock.calls[0]![0]).toMatchObject({ channel: 'chatgpt', session_id: null, tool_name: 'list_business_checking' })
    expect(db.eventInsert.mock.calls[0]![0]).not.toHaveProperty('chat_conversation_id')
  })

  it('tools/call: limit is clamped to 5', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await rpc('tools/call', { name: 'list_business_checking', arguments: { limit: 20 } })
    expect(db.rpc.mock.calls[0]![1].p_limit).toBe(5)
  })

  it('tools/call: invalid args come back as an isError result, not a transport error', async () => {
    setupDb({ list_business_checking: { data: listPayload() } })
    const { body } = await rpc('tools/call', { name: 'list_business_checking', arguments: { monthly_fee_max: 'free' } })
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/monthly_fee_max/)
  })

  it('tools/list also exposes get_listing as-is from v2: read-only, no widget template, 1-4 slugs, only descriptions adapted', async () => {
    const { body } = await rpc('tools/list')
    const t = body.result.tools.find((x: Json) => x.name === 'get_listing')
    expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    expect(t._meta.ui).toBeUndefined()
    const v2 = TOOLS_V2.find((x) => x.name === 'get_listing')!.inputSchema as Json
    expect(t.inputSchema.required).toEqual(v2.required)
    expect(Object.keys(t.inputSchema.properties)).toEqual(Object.keys(v2.properties))
    expect(t.inputSchema.properties.slugs.type).toBe('array')
    expect(t.description).toMatch(/why this account would or would not suit THIS user/)
    expect(t.description).toMatch(/ONLY values in the returned data/)
  })

  it('get_listing: defaults to all five sections, passes slugs through (compare up to 4), strips links, logs get_listing', async () => {
    const db = setupDb({ get_listing_sections: { data: listingPayload() } })
    const { body } = await rpc('tools/call', { name: 'get_listing', arguments: { slugs: ['a-bank', 'b-bank'] } })
    const [fn, args] = db.rpc.mock.calls[0]!
    expect(fn).toBe('get_listing_sections')
    expect(args.p_slugs).toEqual(['a-bank', 'b-bank'])
    expect(args.p_sections).toEqual(['summary', 'tiers', 'fees', 'features', 'promotions'])
    expect(body.result.structuredContent.listings[0].fees).toBeTruthy()
    expect(JSON.stringify(body.result)).not.toMatch(/application_url|bancadia\.com\/go/)
    expect(db.eventInsert.mock.calls[0]![0]).toMatchObject({ channel: 'chatgpt', session_id: null, tool_name: 'get_listing' })
    expect(db.eventInsert.mock.calls[0]![0]).not.toHaveProperty('chat_conversation_id') // no _meta sent: key omitted
    // slugs requested and found are both recoverable from the logged rows
    expect(db.eventInsert.mock.calls[0]![0].query_filters.slugs).toEqual(['a-bank', 'b-bank'])
    expect(db.eventInsert.mock.calls[0]![0].result_count).toBe(1) // fixture returns one listing
    expect(db.matchInsert.mock.calls[0]![0].map((m: Json) => m.listing_slug)).toEqual(['a-bank'])
  })

  it('get_listing: explicit sections are respected; missing or unknown slugs come back as isError results', async () => {
    const db = setupDb({ get_listing_sections: { data: { listings: [], not_found: ['zzz'], returned_ids: [] } } })
    const missing = await rpc('tools/call', { name: 'get_listing', arguments: {} })
    expect(missing.body.result.isError).toBe(true)
    expect(missing.body.result.content[0].text).toMatch(/slugs/)
    const unknown = await rpc('tools/call', { name: 'get_listing', arguments: { slugs: ['zzz'], sections: ['fees'] } })
    expect(db.rpc.mock.calls[0]![1].p_sections).toEqual(['fees'])
    expect(unknown.body.result.isError).toBe(true)
    expect(unknown.body.result.content[0].text).toMatch(/No active listing/)
  })

  it('records ChatGPT\'s conversation id on search AND get_listing so the two can be joined', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() }, get_listing_sections: { data: listingPayload() } })
    const _meta = { 'openai/session': 'conv-abc-123', 'openai/subject': 'user-xyz' }
    await rpc('tools/call', { name: 'list_business_checking', arguments: {}, _meta })
    await rpc('tools/call', { name: 'get_listing', arguments: { slugs: ['a-bank'] }, _meta })
    const rows = db.eventInsert.mock.calls.map((c) => c[0])
    expect(rows.map((r: Json) => [r.tool_name, r.chat_conversation_id])).toEqual([
      ['list_business_checking', 'conv-abc-123'],
      ['get_listing', 'conv-abc-123'],
    ])
    expect(JSON.stringify(rows)).not.toMatch(/user-xyz/) // openai/subject is not stored
  })

  it('conversation id is untrusted input: non-strings are ignored, long values are capped at 200 chars', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await rpc('tools/call', { name: 'list_business_checking', arguments: {}, _meta: { 'openai/session': { nested: true } } })
    await rpc('tools/call', { name: 'list_business_checking', arguments: {}, _meta: { 'openai/session': 'x'.repeat(500) } })
    const [a, b] = db.eventInsert.mock.calls.map((c) => c[0])
    expect(a).not.toHaveProperty('chat_conversation_id')
    expect(b.chat_conversation_id).toHaveLength(200)
  })

  it('every pass-through tool keeps its v2 input schema (same properties and required), links off, read-only', async () => {
    const { body } = await rpc('tools/list')
    expect(body.result.tools.map((t: Json) => t.name)).toEqual(['list_business_checking', 'get_listing', 'search_facts', 'fees_by_type'])
    for (const name of ['get_listing', 'search_facts', 'fees_by_type']) {
      const t = body.result.tools.find((x: Json) => x.name === name)
      const v2 = TOOLS_V2.find((x) => x.name === name)!.inputSchema as Json
      expect(Object.keys(t.inputSchema.properties), name).toEqual(Object.keys(v2.properties)) // drift guard: nothing dropped
      expect(t.inputSchema.required, name).toEqual(v2.required)
      expect(t.annotations, name).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
      expect(t._meta.ui, name).toBeUndefined()
      expect(t.description, name).toMatch(/ONLY values in the returned data/)
      expect(t.description, name).not.toMatch(/application_url/) // links are stripped on this surface
    }
    expect(TOOLS_V2.find((x) => x.name === 'search_facts')!.description).toMatch(/application_url/) // v2 wording is adapted, not edited
  })

  it('known slugs are listed once, in get_listing, as plain text (not an enum), so a bank named cold needs no list call', async () => {
    const { body } = await rpc('tools/list')
    const tool = (n: string) => body.result.tools.find((t: Json) => t.name === n)
    const desc = tool('get_listing').inputSchema.properties.slugs.description as string
    for (const slug of LISTING_SLUGS) expect(desc).toContain(slug)
    expect(desc).toMatch(/call list_business_checking and read its rows or matches_overview/)
    for (const n of ['search_facts', 'fees_by_type']) {
      const d = tool(n).inputSchema.properties.slugs.description as string
      expect(d).toMatch(/same listing_slugs as get_listing/)
      expect(d).not.toContain(LISTING_SLUGS[0]) // listed once, not tripled
    }
    for (const n of ['get_listing', 'search_facts', 'fees_by_type']) expect(tool(n).inputSchema.properties.slugs.items.enum).toBeUndefined() // an enum would block new listings
    expect([...LISTING_SLUGS].sort()).toEqual([...LISTING_SLUGS]) // sorted, so the drift diff is readable
    expect(new Set(LISTING_SLUGS).size).toBe(LISTING_SLUGS.length)
    expect(LISTING_SLUGS.every((s) => /^[a-z0-9-]+$/.test(s))).toBe(true)
  })

  it('search_facts and fees_by_type reach the shared v2 handlers, return object structuredContent, strip links, log with the conversation id', async () => {
    const db = setupDb({ search_listing_facts: { data: factsPayload() }, fees_by_type: { data: feesPayload() } })
    const _meta = { 'openai/session': 'conv-facts' }
    const facts = await rpc('tools/call', { name: 'search_facts', arguments: { query: 'zelle' }, _meta })
    const fees = await rpc('tools/call', { name: 'fees_by_type', arguments: { fee_types: ['cash_deposit'] }, _meta })
    expect(db.rpc.mock.calls.map((c) => c[0])).toEqual(['search_listing_facts', 'fees_by_type'])
    expect(facts.body.result.structuredContent.hits[0].facts[0].topic).toBe('fees')
    expect(Array.isArray(fees.body.result.structuredContent)).toBe(false) // v2 returns a bare array; wrapped for structuredContent
    expect(fees.body.result.structuredContent.results[0].fees[0].fee_type).toBe('cash_deposit')
    expect(JSON.stringify([facts.body.result, fees.body.result])).not.toMatch(/application_url|bancadia\.com\/go/)
    expect(db.eventInsert.mock.calls.map((c) => [c[0].tool_name, c[0].channel, c[0].chat_conversation_id])).toEqual([
      ['search_facts', 'chatgpt', 'conv-facts'],
      ['fees_by_type', 'chatgpt', 'conv-facts'],
    ])
  })

  it('search: *_display names are never requested as columns, so the model asking for them cannot fail the call', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const { body } = await rpc('tools/call', { name: 'list_business_checking', arguments: { fields: ['monthly_fee_display', 'apy_display', 'apy_tiers'] } })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    const sent = db.rpc.mock.calls[0]![1].p_fields
    expect(sent).toContain('apy_tiers')
    expect(sent.filter((f: string) => f.endsWith('_display'))).toEqual([])
    expect(body.result.isError).toBeUndefined()
  })

  it('search: when v2 rejects unknown field names (filters or invented columns), they are dropped and the call retried once', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'Unknown field: integrations, integrations_any. Valid fields: institution_name, product_name' } })
    const { body } = await rpc('tools/call', { name: 'list_business_checking', arguments: { fields: ['integrations', 'integrations_any', 'apy_tiers'] } })
    expect(db.rpc).toHaveBeenCalledTimes(2)
    const [first, second] = db.rpc.mock.calls.map((c) => c[1].p_fields as string[])
    expect(first).toEqual(expect.arrayContaining(['integrations', 'integrations_any', 'apy_tiers']))
    expect(second).toContain('apy_tiers') // valid extras are kept
    expect(second).not.toContain('integrations')
    expect(second).not.toContain('integrations_any')
    expect(body.result.isError).toBeUndefined()
    expect(body.result.structuredContent.rows).toHaveLength(2)
  })

  it('search: a rejection that is not about unknown fields is returned as is, with no retry', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'Unknown sort: bogus' } })
    const { body } = await rpc('tools/call', { name: 'list_business_checking', arguments: { sort: 'bogus' } })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(body.result.isError).toBe(true)
  })

  it('does not disturb the existing endpoint', async () => {
    setupDb({ list_business_checking: { data: listPayload() } })
    const r = await callMcp('list_business_checking', {})
    expect(r.ok).toBe(true)
  })
})
