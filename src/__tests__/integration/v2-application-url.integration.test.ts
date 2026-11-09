import { describe, it, expect, vi } from 'vitest'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }) }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})
// No vi.mock('../../lib/supabase'): real local Supabase, like the sibling suites.

import { mcpOk, rest, bankRows, expectTaggedUrl, eventsFor, K } from './v2-helpers'


const ALL4 = [K.found, K.lili, K.chase, K.citibank]
// path '' = no REST equivalent (multi-slug get_listing: the REST compare route was removed; REST reads one listing at a time)
type Case = { name: string; tool: string; args: Record<string, unknown>; path: string }

// Every way a bank can appear in a response, per tool. Each must carry a tagged application_url.
const CASES: Case[] = [
  { name: 'list default', tool: 'list_business_checking', args: {}, path: '/business-checking-listings' },
  { name: 'list with fields selection', tool: 'list_business_checking', args: { fields: ['apy_max'] }, path: '/business-checking-listings?fields=apy_max' },
  { name: 'list page 2 (offset)', tool: 'list_business_checking', args: { limit: 3, offset: 3 }, path: '/business-checking-listings?limit=3&offset=3' },
  { name: 'list with integrations filter', tool: 'list_business_checking', args: { integrations_any: ['quickbooks'] }, path: '/business-checking-listings?integrations_any=quickbooks' },
  { name: 'list with min_limits', tool: 'list_business_checking', args: { min_limits: { sub_accounts: 12 } }, path: '/business-checking-listings?min_limits=sub_accounts:12' },
  { name: 'search_facts hits', tool: 'search_facts', args: { query: 'cash deposit' }, path: '/business-checking-listings/-/facts?query=cash%20deposit' },
  { name: 'search_facts hits + no_match (scoped)', tool: 'search_facts', args: { query: 'barcode', slugs: [K.found, K.mercury, K.citibank] }, path: `/business-checking-listings/-/facts?query=barcode&slugs=${K.found},${K.mercury},${K.citibank}` },
  { name: 'fees_by_type unscoped', tool: 'fees_by_type', args: { fee_types: ['cash_deposit'] }, path: '/business-checking-listings/-/fees?fee_types=cash_deposit' },
  { name: 'fees_by_type scoped', tool: 'fees_by_type', args: { fee_types: ['cash_deposit', 'overdraft'], slugs: ALL4 }, path: `/business-checking-listings/-/fees?fee_types=cash_deposit,overdraft&slugs=${ALL4.join(',')}` },
  { name: 'get_listing multi-slug', tool: 'get_listing', args: { slugs: ALL4 }, path: '' },
  { name: 'get_listing one slug, fees only', tool: 'get_listing', args: { slugs: [K.found], sections: ['fees'] }, path: '' },
]

// Proves: every bank-bearing row of every tool response carries a host-prefixed application_url tagged with
// src=mcp and a qr uuid, in all the shapes a bank can appear in (fields selection, paging, filters, multi-slug,
// search hits and no_match, fees, listings).
describe('application_url tagging over MCP', () => {
  it.each(CASES)('$name: every bank row is tagged (src=mcp, qr uuid)', async ({ tool, args }) => {
    const { data } = await mcpOk(tool, args)
    const rows = bankRows(tool, data)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expectTaggedUrl(row.application_url, 'mcp')
  })

  it('search_facts scoped query returns both hits and no_match rows, both tagged', async () => {
    const { data } = await mcpOk('search_facts', { query: 'barcode', slugs: [K.found, K.mercury, K.citibank] })
    expect(data.hits.length).toBeGreaterThan(0)
    expect(data.no_match.length).toBeGreaterThan(0)
    for (const row of [...data.hits, ...data.no_match]) expectTaggedUrl(row.application_url, 'mcp')
  })

  it('all rows of one call share one qr, and it equals the logged query_events.request_id', async () => {
    const sessionId = crypto.randomUUID()
    const { data } = await mcpOk('list_business_checking', { limit: 5 }, { sessionId })
    const qrs = new Set(data.rows.map((r: any) => expectTaggedUrl(r.application_url, 'mcp')))
    expect(qrs.size).toBe(1)
    const events = await eventsFor(sessionId)
    expect(events).toHaveLength(1)
    expect(events[0].request_id).toBe([...qrs][0])
  })

  it.each(['search_facts', 'fees_by_type', 'get_listing'])('qr equals the logged request_id for %s', async (tool) => {
    const sessionId = crypto.randomUUID()
    const args: Record<string, Record<string, unknown>> = {
      search_facts: { query: 'cash deposit' },
      fees_by_type: { fee_types: ['cash_deposit'] },
      get_listing: { slugs: [K.found, K.lili] },
    }
    const { data } = await mcpOk(tool, args[tool]!, { sessionId })
    const qr = expectTaggedUrl(bankRows(tool, data)[0]!.application_url, 'mcp')
    const events = await eventsFor(sessionId)
    expect(events.map((e) => e.request_id)).toEqual([qr])
  })
})

// Proves: the same tagging on REST, with src=rest and qr equal to the X-Request-Id header (which is also the
// logged request_id).
describe('application_url tagging over REST', () => {
  it.each(CASES.filter((c) => c.path))('$name: every bank row is tagged (src=rest, qr = X-Request-Id)', async ({ tool, path }) => {
    const r = await rest(path)
    expect(r.status).toBe(200)
    const rows = tool === 'list_business_checking' ? r.body.data : r.body.data
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    const extra = tool === 'search_facts' ? r.body.meta.no_match ?? [] : []
    for (const row of [...rows, ...extra]) expect(expectTaggedUrl(row.application_url, 'rest')).toBe(r.requestId)
  })

  it('single-listing route tags its one listing', async () => {
    const r = await rest(`/business-checking-listings/${K.found}`)
    expect(r.status).toBe(200)
    expect(expectTaggedUrl(r.body.data.application_url, 'rest')).toBe(r.requestId)
  })

  it.each(['fees', 'features', 'promotions', 'plans'])('sub-route /%s carries the tagged link in meta.listing', async (sub) => {
    const r = await rest(`/business-checking-listings/${K.relay}/${sub}`)
    expect(r.status).toBe(200)
    expect(r.body.meta.listing.listing_slug).toBe(K.relay)
    expect(expectTaggedUrl(r.body.meta.listing.application_url, 'rest')).toBe(r.requestId)
  })

  it('deprecated alias routes tag links the same way', async () => {
    const r = await rest(`/business-checking/${K.found}`)
    expect(expectTaggedUrl(r.body.data.application_url, 'rest')).toBe(r.requestId)
    const l = await rest('/business-checking')
    for (const row of l.body.data) expect(expectTaggedUrl(row.application_url, 'rest')).toBe(l.requestId)
  })
})
