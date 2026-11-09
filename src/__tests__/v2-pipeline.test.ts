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

import { setupDb, callMcp, callRest, listPayload, factsPayload, feesPayload, listingPayload, type Json } from './v2-unit-helpers'

beforeEach(() => vi.clearAllMocks())
const strip = (x: Json) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'application_url' ? undefined : v)))

// Proves: the Worker maps tool arguments to the exact RPC parameters of the DB contract (rename rank_*, keep
// limit/fields/offset out of p_filters, omit what the caller did not send, normalize case).
describe('v2 argument to RPC mapping', () => {
  it('list_business_checking', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await callMcp('list_business_checking', {
      monthly_fee_max: 0, insurance_type: 'FDIC', entity_types_accepted: ['LLC'], available_states: ['ny'],
      rank_industries: ['Ecommerce'], rank_profiles: ['VC_backed'], integrations_any: ['QBO'], integrations_all: ['Xero'],
      min_limits: { SUB_ACCOUNTS: 3 }, sort: 'Apy_Max_Desc', fields: ['APY_MAX'], limit: 5, offset: 10,
    })
    expect(db.rpc).toHaveBeenCalledTimes(1)
    expect(db.rpc.mock.calls[0]).toEqual([
      'list_business_checking',
      {
        p_filters: {
          monthly_fee_max: 0, insurance_type: 'fdic', entity_types_accepted: ['llc'], available_states: ['NY'],
          target_industries: ['ecommerce'], target_business_profiles: ['vc_backed'], integrations_any: ['qbo'],
          integrations_all: ['xero'], min_limits: { sub_accounts: 3 }, sort: 'apy_max_desc',
        },
        p_fields: ['apy_max'], p_limit: 5, p_offset: 10,
      },
    ])
  })

  it('has_active_promotion goes into p_filters under the same name (false is kept), and adds the notes caveat only when sent', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const withFlag = await callMcp('list_business_checking', { has_active_promotion: false })
    expect((db.rpc.mock.calls[0]![1] as Json).p_filters).toEqual({ has_active_promotion: false })
    if (!withFlag.ok) throw new Error(withFlag.message)
    expect(withFlag.data.notes).toMatch(/Promotions are recorded for only some banks; no promotion listed may mean not recorded\./)
    const without = await callMcp('list_business_checking', {})
    if (!without.ok) throw new Error(without.message)
    expect(without.data.notes).not.toMatch(/Promotions/)
    const bad = await callMcp('list_business_checking', { has_active_promotion: 'yes' })
    expect(bad).toMatchObject({ ok: false, code: -32602 })
    expect(!bad.ok && bad.message).toMatch(/has_active_promotion/)
    const rest = await callRest('/business-checking-listings?has_active_promotion=true')
    expect(rest.body.meta.notes).toMatch(/Promotions are recorded/)
    expect((db.rpc.mock.calls.at(-1)![1] as Json).p_filters).toEqual({ has_active_promotion: true })
  })

  it('list_business_checking with no args sends only an empty filter object (DB defaults apply)', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await callMcp('list_business_checking', {})
    const params = db.rpc.mock.calls[0]![1] as Json
    expect(params.p_filters).toEqual({})
    for (const k of ['p_fields', 'p_limit', 'p_offset']) expect(params[k] ?? undefined).toBeUndefined()
  })

  it('search_facts keeps the query verbatim (negation and phrases survive) and normalizes the rest', async () => {
    const db = setupDb({ search_listing_facts: { data: factsPayload() } })
    await callMcp('search_facts', { query: 'cash -deposit "Free Cash" or ZELLE', slugs: ['A-Bank'], topic: 'FEES', per_bank: 1, max_banks: 2, max_chars: 80 })
    expect(db.rpc.mock.calls[0]).toEqual([
      'search_listing_facts',
      { p_query: 'cash -deposit "Free Cash" or ZELLE', p_slugs: ['a-bank'], p_topic: 'fees', p_per_bank: 1, p_max_banks: 2, p_max_chars: 80 },
    ])
  })

  it('fees_by_type', async () => {
    const db = setupDb({ fees_by_type: { data: feesPayload() } })
    await callMcp('fees_by_type', { fee_types: ['Cash_Deposit'], slugs: ['X'], plan: ' Grow ' })
    expect(db.rpc.mock.calls[0]).toEqual(['fees_by_type', { p_fee_types: ['cash_deposit'], p_slugs: ['x'], p_plan: 'Grow' }])
  })

  it('get_listing, with and without sections', async () => {
    const db = setupDb({ get_listing_sections: { data: listingPayload() } })
    await callMcp('get_listing', { slugs: ['A', 'B'], sections: ['FEES'] })
    expect(db.rpc.mock.calls[0]).toEqual(['get_listing_sections', { p_slugs: ['a', 'b'], p_sections: ['fees'] }])
    await callMcp('get_listing', { slugs: ['A'] })
    const p = db.rpc.mock.calls[1]![1] as Json
    expect(p.p_slugs).toEqual(['a'])
    expect(p.p_sections ?? undefined).toBeUndefined()
  })

  it('REST query strings map the same way (integers, arrays, min_limits key:number pairs)', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const r = await callRest('/business-checking-listings?limit=5&offset=10&entity_types_accepted=LLC,nonprofit&min_limits=sub_accounts:12,free_wires:2&rank_industries=Ecommerce')
    expect(r.status).toBe(200)
    expect(db.rpc.mock.calls[0]![0]).toBe('list_business_checking')
    const p = db.rpc.mock.calls[0]![1] as Json
    expect(p.p_limit).toBe(5)
    expect(p.p_offset).toBe(10)
    expect(p.p_filters).toEqual({ entity_types_accepted: ['llc', 'nonprofit'], min_limits: { sub_accounts: 12, free_wires: 2 }, target_industries: ['ecommerce'] })
  })
})

// Proves: internal keys are stripped, fees_by_type is unwrapped, every bank link is tagged, notes/hint are added,
// and nothing else is touched (the Worker never post-filters or "fixes" DB data).
describe('v2 response shaping', () => {
  it('list: removes returned_ids, keeps the DB keys, adds notes and hint, tags rows, leaves matches_overview alone', async () => {
    setupDb({ list_business_checking: { data: listPayload() } })
    const r = await callMcp('list_business_checking', { limit: 2, offset: 2 })
    if (!r.ok) throw new Error(r.message)
    const { returned_ids, ...dbKeys } = listPayload()
    expect(r.text).not.toContain('returned_ids')
    expect(r.text).not.toContain('id-a')
    expect(Object.keys(r.data).sort()).toEqual([...Object.keys(dbKeys), 'hint', 'notes'].sort())
    expect(r.data.matches_overview).toEqual(dbKeys.matches_overview)
    expect(typeof r.data.notes).toBe('string')
    expect(r.data.notes).not.toMatch(/\n/)
    expect(r.data.notes).toMatch(/absent/i)
    expect(r.data.hint).toMatch(/search_facts/)
    for (const x of r.data.rows) expect(x.application_url).toMatch(/^https:\/\/bancadia\.com\/go\/.+\?src=mcp&qr=[0-9a-f-]{36}$/)
    expect(strip(r.data.rows)).toEqual(strip(dbKeys.rows))
  })

  it('search_facts: removes returned_ids, tags hits and no_match', async () => {
    setupDb({ search_listing_facts: { data: factsPayload() } })
    const r = await callMcp('search_facts', { query: 'x' })
    if (!r.ok) throw new Error(r.message)
    expect(r.text).not.toContain('returned_ids')
    for (const x of [...r.data.hits, ...r.data.no_match]) expect(x.application_url).toMatch(/^https:\/\/bancadia\.com\/go\/.+src=mcp&qr=/)
    expect(r.data.scanned).toBe(2)
  })

  it('fees_by_type: the MCP payload is the unwrapped .results array, tagged', async () => {
    setupDb({ fees_by_type: { data: feesPayload() } })
    const r = await callMcp('fees_by_type', { fee_types: ['cash_deposit'] })
    if (!r.ok) throw new Error(r.message)
    expect(Array.isArray(r.data)).toBe(true)
    expect(r.text).not.toContain('returned_ids')
    expect(strip(r.data)).toEqual(strip(feesPayload().results))
    expect(r.data[0].application_url).toMatch(/src=mcp&qr=/)
  })

  it('get_listing: removes returned_ids, keeps not_found, tags listings', async () => {
    setupDb({ get_listing_sections: { data: listingPayload() } })
    const r = await callMcp('get_listing', { slugs: ['a-bank', 'zzz'] })
    if (!r.ok) throw new Error(r.message)
    expect(r.text).not.toContain('returned_ids')
    expect(r.data.not_found).toEqual(['zzz'])
    expect(r.data.listings[0].application_url).toMatch(/src=mcp&qr=/)
  })

  it('REST list: data is the rows array, meta carries paging + overview, returned_ids removed', async () => {
    setupDb({ list_business_checking: { data: listPayload() } })
    const r = await callRest('/business-checking-listings?limit=2&offset=2')
    expect(r.status).toBe(200)
    expect(r.text).not.toContain('returned_ids')
    expect(r.body.data).toHaveLength(2)
    expect(r.body.meta).toMatchObject({ count: 2, request_id: r.requestId, total_matches: 5, returned: 2, limit: 2, next_offset: 2 })
    expect(r.body.meta.matches_overview).toHaveLength(5)
    expect(r.body.data[0].application_url).toContain(`src=rest&qr=${r.requestId}`)
  })

  it('no hint and no overview when there are no rows (empty bank / no match)', async () => {
    setupDb({ list_business_checking: { data: { rows: [], total_matches: 0, returned: 0, limit: 7, next_offset: null, excluded_by: { monthly_fee_max: 13 }, returned_ids: [] } } })
    const r = await callMcp('list_business_checking', { monthly_fee_max: -1 })
    if (!r.ok) throw new Error(r.message)
    expect(r.data.rows).toEqual([])
    expect('hint' in r.data).toBe(false)
    expect('matches_overview' in r.data).toBe(false)
    expect(r.data.next_offset).toBeNull()
    expect(typeof r.data.notes).toBe('string')
  })

  it('empty fees_by_type result is []', async () => {
    setupDb({ fees_by_type: { data: { results: [], returned_ids: [] } } })
    const r = await callMcp('fees_by_type', { fee_types: ['dormancy'] })
    if (!r.ok) throw new Error(r.message)
    expect(r.data).toEqual([])
  })

  it('does not reconcile flat summary values with fee rows: a disagreement is passed through untouched', async () => {
    const data = {
      listings: [{
        slug: 'a-bank', application_url: '/go/a/checking', detail_has: ['fees:1'],
        summary: { cash_deposit_fee_per_100: 0.3, outgoing_domestic_wire_fee: 25 },
        fees: [{ fee_type: 'cash_deposit', plan: 'all plans', amount: 2, fee_unit: 'per_transaction' }, { fee_type: 'wire_domestic_outgoing', plan: 'all plans', amount: 15 }],
      }],
      returned_ids: [{ id: 'id-a', rank: 1, slug: 'a-bank' }],
    }
    setupDb({ get_listing_sections: { data } })
    const r = await callMcp('get_listing', { slugs: ['a-bank'], sections: ['summary', 'fees'] })
    if (!r.ok) throw new Error(r.message)
    expect(r.data.listings[0].summary).toEqual(data.listings[0]!.summary)
    expect(r.data.listings[0].fees).toEqual(data.listings[0]!.fees)
  })
})

// Proves: DB exceptions map to tool errors (invalid-params with the DB text, or a generic internal error that never
// leaks the raw message), on both channels, and are logged with the right status.
describe('v2 error mapping', () => {
  const dbMsg = 'Unknown insurance type: bogus. Valid insurance types: fdic, ncua, uninsured'

  it('MCP: SQLSTATE 22023 -> -32602 with the DB message; logged invalid_args', async () => {
    const db = setupDb({ list_business_checking: { error: { message: dbMsg, code: '22023' } } })
    const r = await callMcp('list_business_checking', { insurance_type: 'bogus' })
    expect(r).toMatchObject({ ok: false, code: -32602, message: dbMsg })
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'invalid_args', profile: 'v2', error_message: dbMsg }))
    expect(db.matchInsert).not.toHaveBeenCalled()
  })

  it('REST: SQLSTATE 22023 -> 400 problem+json with the DB message (not 500)', async () => {
    setupDb({ list_business_checking: { error: { message: dbMsg, code: '22023' } } })
    const r = await callRest('/business-checking-listings?insurance_type=bogus')
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ status: 400, detail: dbMsg })
  })

  it('MCP: any other DB error -> -32603 generic, raw message not leaked; logged error', async () => {
    const db = setupDb({ fees_by_type: { error: { message: 'relation "secret_table" does not exist', code: '42P01' } } })
    const r = await callMcp('fees_by_type', { fee_types: ['cash_deposit'] })
    expect(r).toMatchObject({ ok: false, code: -32603 })
    expect(!r.ok && r.message).not.toMatch(/secret_table/)
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', profile: 'v2' }))
  })

  it('REST: any other DB error -> 500 generic', async () => {
    const db = setupDb({ search_listing_facts: { error: { message: 'connection refused to 10.0.0.1', code: '08006' } } })
    const r = await callRest('/business-checking-listings/-/facts?query=x')
    expect(db.rpc).toHaveBeenCalledTimes(1) // the v2 facts route reached the DB function
    expect(r.status).toBe(500)
    expect(r.text).not.toContain('10.0.0.1')
  })

  it('an untagged bank row from the DB (runtime assert) is an internal error, never an untagged payload', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload({ rows: [{ listing_slug: 'a-bank' }], returned: 1 }) } })
    const r = await callMcp('list_business_checking', {})
    expect(r).toMatchObject({ ok: false, code: -32603 })
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }))
    const rest = await callRest('/business-checking-listings')
    expect(rest.status).toBe(500)
  })

  it('unknown states are rejected by the Worker with the valid list, without calling the DB', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const r = await callMcp('list_business_checking', { available_states: ['NY', 'ZZ'] })
    expect(r).toMatchObject({ ok: false, code: -32602 })
    expect(!r.ok && r.message).toMatch(/ZZ/)
    expect(!r.ok && r.message).toMatch(/Valid states:.*\bNY\b.*\bTX\b/)
    expect(db.rpc).not.toHaveBeenCalled()
    const ok = await callMcp('list_business_checking', { available_states: ['ALL', 'dc', 'pr'] })
    expect(ok.ok).toBe(true)
  })

  it.each([
    ['limit string', { limit: 'abc' }, /limit/],
    ['limit fraction', { limit: 2.5 }, /limit/],
    ['offset string', { offset: '1' }, /offset/],
    ['min_limits not an object', { min_limits: 3 }, /min_limits/],
    ['min_limits value not a number', { min_limits: { sub_accounts: 'x' } }, /min_limits/],
    ['fields not an array', { fields: 'apy_max' }, /fields/],
  ])('type errors are -32602 before any DB call: %s', async (_n, args, re) => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    const r = await callMcp('list_business_checking', args)
    expect(r).toMatchObject({ ok: false, code: -32602 })
    expect(!r.ok && r.message).toMatch(re)
    expect(db.rpc).not.toHaveBeenCalled()
  })
})

// Proves: query_events gets the new columns and query_match_events is written from returned_ids only.
describe('v2 logging from returned_ids', () => {
  it('list: columns populated; match rows = returned_ids with global ranks, not matches_overview', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await callMcp('list_business_checking', { limit: 2, offset: 2, fields: ['APY_MAX'], monthly_fee_max: 0 })
    expect(db.eventInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_name: 'list_business_checking', channel: 'mcp', status: 'ok', profile: 'v2',
        total_matches: 5, offset: 2, fields: ['apy_max'], result_count: 2,
        query_filters: { limit: 2, offset: 2, fields: ['APY_MAX'], monthly_fee_max: 0 },
      })
    )
    const rows = db.matchInsert.mock.calls[0]![0] as Json[]
    const reqId = (db.eventInsert.mock.calls[0]![0] as Json).request_id
    expect(rows).toEqual([
      { request_id: reqId, listing_id: 'id-a', listing_slug: 'a-bank', institution_id: null, result_rank: 3 },
      { request_id: reqId, listing_id: 'id-b', listing_slug: 'b-bank', institution_id: null, result_rank: 4 },
    ])
  })

  it('list defaults: offset 0 and fields null', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload({ returned_ids: [{ id: 'id-a', rank: 1, slug: 'a-bank' }, { id: 'id-b', rank: 2, slug: 'b-bank' }] }) } })
    await callMcp('list_business_checking', {})
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ offset: 0, fields: null }))
  })

  it('search_facts: no_match banks are not recorded; total_matches = banks_matched', async () => {
    const db = setupDb({ search_listing_facts: { data: factsPayload() } })
    await callMcp('search_facts', { query: 'x', slugs: ['a-bank', 'b-bank'] })
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ tool_name: 'search_facts', result_count: 1, total_matches: 1, profile: 'v2' }))
    expect((db.matchInsert.mock.calls[0]![0] as Json[]).map((m) => m.listing_slug)).toEqual(['a-bank'])
  })

  it('get_listing: not_found slugs are not recorded', async () => {
    const db = setupDb({ get_listing_sections: { data: listingPayload() } })
    await callMcp('get_listing', { slugs: ['a-bank', 'zzz'] })
    expect((db.matchInsert.mock.calls[0]![0] as Json[]).map((m) => m.listing_slug)).toEqual(['a-bank'])
  })

  it('fees_by_type: recorded from the wrapper returned_ids', async () => {
    const db = setupDb({ fees_by_type: { data: feesPayload() } })
    await callMcp('fees_by_type', { fee_types: ['cash_deposit'] })
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ tool_name: 'fees_by_type', result_count: 1, total_matches: 1 }))
    expect((db.matchInsert.mock.calls[0]![0] as Json[])[0]).toMatchObject({ listing_id: 'id-a', result_rank: 1 })
  })

  it('zero rows: event with result_count 0 and total_matches 0, no match insert', async () => {
    const db = setupDb({ list_business_checking: { data: { rows: [], total_matches: 0, returned: 0, limit: 7, next_offset: null, returned_ids: [] } } })
    await callMcp('list_business_checking', { monthly_fee_max: -1 })
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok', result_count: 0, total_matches: 0 }))
    expect(db.matchInsert).not.toHaveBeenCalled()
  })

  it('REST events: channel rest, profile v2, session_id null', async () => {
    const db = setupDb({ list_business_checking: { data: listPayload() } })
    await callRest('/business-checking-listings?limit=2&offset=2')
    expect(db.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ channel: 'rest', profile: 'v2', session_id: null, offset: 2, total_matches: 5 }))
  })

  it('a legacy-profile call is logged with profile legacy', async () => {
    // legacy path still uses table queries; give it an empty result
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'lte', 'gte']) chain[m] = vi.fn().mockReturnValue(chain)
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
    const { mockAnalyticsTables } = await import('./helpers')
    const { createSupabaseClient } = await import('../lib/supabase')
    const t = mockAnalyticsTables(chain)
    vi.mocked(createSupabaseClient).mockReturnValue({ from: t.from } as never)
    await callMcp('query_business_checking', {}, { profile: 'legacy' })
    expect(t.eventInsert).toHaveBeenCalledWith(expect.objectContaining({ tool_name: 'query_business_checking', profile: 'legacy' }))
  })
})

describe('v2 never exposes affiliate fields', () => {
  it('a payload from the DB without them stays without them across all four tools', async () => {
    setupDb({
      list_business_checking: { data: listPayload() }, search_listing_facts: { data: factsPayload() },
      fees_by_type: { data: feesPayload() }, get_listing_sections: { data: listingPayload() },
    })
    const outs = [
      await callMcp('list_business_checking', {}), await callMcp('search_facts', { query: 'x' }),
      await callMcp('fees_by_type', { fee_types: ['cash_deposit'] }), await callMcp('get_listing', { slugs: ['a-bank'] }),
    ]
    for (const o of outs) {
      if (!o.ok) throw new Error(o.message)
      expect(o.text).not.toMatch(/"(is_affiliate|tracker_url|affiliate_)/)
    }
  })
})
