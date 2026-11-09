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

import { mcpOk, mcpErr, mcp, rpc, deepKeys, db, activeListings, K } from './v2-helpers'


const list = (args: Record<string, unknown> = {}, opts: Parameters<typeof mcp>[2] = {}) =>
  mcpOk('list_business_checking', { limit: 20, ...args }, opts).then((r) => r.data)
const slugs = (d: any) => d.rows.map((r: any) => r.listing_slug) as string[]
const DEFAULTS = ['institution_name', 'product_name', 'monthly_fee', 'minimum_opening_deposit', 'insurance_type', 'apy_max', 'apy_default', 'free_transactions_per_month']

// Proves: `fields` selects columns (listing_slug and application_url always stay), default rows are slim, and
// unit-bearing values like 0 survive slimming.
describe('v2 fields and slim rows', () => {
  it('default rows only use the default field set plus listing_slug and application_url', async () => {
    const d = await list()
    for (const row of d.rows) for (const k of Object.keys(row)) expect([...DEFAULTS, 'listing_slug', 'application_url']).toContain(k)
  })

  it('fields replaces the defaults but listing_slug and application_url are always present', async () => {
    const d = await list({ fields: ['apy_max', 'monthly_fee'] })
    for (const row of d.rows) {
      expect(row.listing_slug).toBeTruthy()
      expect(row.application_url).toBeTruthy()
      for (const k of Object.keys(row)) expect(['listing_slug', 'application_url', 'apy_max', 'monthly_fee']).toContain(k)
    }
  })

  it('field names are case-insensitive', async () => {
    const d = await list({ fields: ['APY_Max'] })
    expect(d.rows.some((r: any) => r.apy_max !== undefined)).toBe(true)
  })

  it('plan_tiers can be selected and carry plan_name', async () => {
    const d = await list({ fields: ['plan_tiers'], limit: 20 })
    const relay = d.rows.find((r: any) => r.listing_slug === K.relay)
    expect(relay.plan_tiers.length).toBeGreaterThan(1)
    expect(relay.plan_tiers.every((t: any) => typeof t.plan_name === 'string')).toBe(true)
  })

  it('rows are slim: no null, false, empty string, empty array or empty object values anywhere', async () => {
    const d = await list({ fields: ['plan_tiers', 'promotions', 'entity_types_accepted', 'cash_deposit_available', 'rtp_supported', 'apy_tiers'] })
    const bad: string[] = []
    const walk = (v: any, path: string) => {
      if (v === null || v === false || v === '' || (Array.isArray(v) && v.length === 0) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)) bad.push(path)
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
    }
    walk(d.rows, 'rows')
    expect(bad).toEqual([])
  })

  it('keeps 0 (minimum_opening_deposit 0 and monthly_fee 0 are present, not slimmed away)', async () => {
    const d = await list({ fields: ['minimum_opening_deposit', 'monthly_fee'] })
    expect(d.rows.some((r: any) => r.minimum_opening_deposit === 0)).toBe(true)
    expect(d.rows.some((r: any) => r.monthly_fee === 0)).toBe(true)
  })

  it('matches the DB function output for the same fields', async () => {
    const direct = await rpc('list_business_checking', { p_filters: {}, p_fields: ['apy_max'], p_limit: 20, p_offset: 0 })
    const d = await list({ fields: ['apy_max'] })
    expect(d.rows.map((r: any) => ({ s: r.listing_slug, a: r.apy_max }))).toEqual(direct.rows.map((r: any) => ({ s: r.listing_slug, a: r.apy_max })))
  })
})

// Proves: enum-like args are case-insensitive (same results as lower case).
describe('v2 case-insensitive arguments', () => {
  it('insurance_type FDIC == fdic', async () => {
    expect((await list({ insurance_type: 'FDIC' })).total_matches).toBe((await list({ insurance_type: 'fdic' })).total_matches)
  })
  it('entity_types_accepted [LLC, Sole_Prop] == [llc, sole_prop]', async () => {
    expect(slugs(await list({ entity_types_accepted: ['LLC', 'Sole_Prop'] }))).toEqual(slugs(await list({ entity_types_accepted: ['llc', 'sole_prop'] })))
  })
  it('rtp_network BOTH == both (and it is non-empty)', async () => {
    const upper = await list({ rtp_network: 'BOTH' })
    expect(upper.total_matches).toBeGreaterThan(0)
    expect(slugs(upper)).toEqual(slugs(await list({ rtp_network: 'both' })))
  })
  it('sort APY_MAX_DESC == apy_max_desc', async () => {
    expect(slugs(await list({ sort: 'APY_MAX_DESC' }))).toEqual(slugs(await list({ sort: 'apy_max_desc' })))
  })
  it('rank_industries ECOMMERCE is accepted', async () => {
    expect((await list({ rank_industries: ['ECOMMERCE'] })).total_matches).toBe((await list()).total_matches)
  })
  it('available_states lower-case ny == NY', async () => {
    expect(slugs(await list({ available_states: ['ny'] }))).toEqual(slugs(await list({ available_states: ['NY'] })))
  })
  it('search_facts topic FEES == fees; get_listing sections FEES works; fees_by_type CASH_DEPOSIT works', async () => {
    const t = await mcpOk('search_facts', { query: 'cash deposit', topic: 'FEES' })
    expect(t.data.hits.length).toBeGreaterThan(0)
    const g = await mcpOk('get_listing', { slugs: [K.found.toUpperCase()], sections: ['FEES'] })
    expect(g.data.listings[0].fees.length).toBeGreaterThan(0)
    const f = await mcpOk('fees_by_type', { fee_types: ['CASH_DEPOSIT'] })
    expect(f.data.length).toBeGreaterThan(0)
  })
})

// Proves: invalid enum-like values are rejected with a JSON-RPC invalid-params error (-32602, never -32603)
// whose message lists the valid values.
describe('v2 invalid values list the valid ones', () => {
  const cases: Array<[string, string, Record<string, unknown>, RegExp]> = [
    ['list insurance_type', 'list_business_checking', { insurance_type: 'bogus' }, /fdic.*ncua.*uninsured/s],
    ['list entity type', 'list_business_checking', { entity_types_accepted: ['zzz'] }, /sole_prop/],
    ['list state', 'list_business_checking', { available_states: ['ZZ'] }, /NY/],
    ['list rtp_network', 'list_business_checking', { rtp_network: 'bogus' }, /fednow/],
    ['list integration name', 'list_business_checking', { integrations_any: ['nopeware'] }, /quickbooks/],
    ['list min_limits key', 'list_business_checking', { min_limits: { nope: 1 } }, /sub_accounts/],
    ['list fields', 'list_business_checking', { fields: ['zzz'] }, /apy_max/],
    ['list sort', 'list_business_checking', { sort: 'x' }, /monthly_fee_asc/],
    ['list rank_industries', 'list_business_checking', { rank_industries: ['zzz'] }, /ecommerce/],
    ['search topic', 'search_facts', { query: 'fee', topic: 'zzz' }, /payment_rails/],
    ['fees fee type', 'fees_by_type', { fee_types: ['zzz'] }, /cash_deposit/],
    ['get_listing section', 'get_listing', { slugs: [K.found], sections: ['zzz'] }, /promotions/],
  ]
  it.each(cases)('%s', async (_n, tool, args, re) => {
    const e = await mcpErr(tool, args)
    expect(e.code).toBe(-32602)
    expect(e.message).toMatch(re)
  })

  it('wrongly typed arguments are -32602 naming the argument (limit, min_limits value, query)', async () => {
    expect((await mcpErr('list_business_checking', { limit: 'abc' })).message).toMatch(/limit/)
    expect((await mcpErr('list_business_checking', { limit: 2.5 })).message).toMatch(/limit/)
    expect((await mcpErr('list_business_checking', { min_limits: { sub_accounts: 'x' } })).message).toMatch(/min_limits/)
    expect((await mcpErr('search_facts', {})).message).toMatch(/query/)
    expect((await mcpErr('get_listing', {})).message).toMatch(/slugs/)
  })
})

// Proves: rank_* never exclude, and the hard entity/state filters behave exactly like the legacy tool.
describe('v2 filters', () => {
  it('rank_industries and rank_profiles never exclude, alone or with a hard filter', async () => {
    const hard = await list({ monthly_fee_max: 0 })
    const ranked = await list({ monthly_fee_max: 0, rank_industries: ['agriculture'], rank_profiles: ['vc_backed'] })
    expect(ranked.total_matches).toBe(hard.total_matches)
    expect(slugs(ranked).sort()).toEqual(slugs(hard).sort())
  })

  const parity: Array<[string, Record<string, unknown>]> = [
    ['entity sole_prop', { entity_types_accepted: ['sole_prop'] }],
    ['entity sole_prop + nonprofit (all-of)', { entity_types_accepted: ['sole_prop', 'nonprofit'] }],
    ['entity llc + s_corp + c_corp', { entity_types_accepted: ['llc', 's_corp', 'c_corp'] }],
    ['state NY', { available_states: ['NY'] }],
    ['states NY + TX', { available_states: ['NY', 'TX'] }],
    ["state 'ALL'", { available_states: ['ALL'] }],
    ['fee 0 + entity nonprofit + state CA', { monthly_fee_max: 0, entity_types_accepted: ['nonprofit'], available_states: ['CA'] }],
  ]
  it.each(parity)('same set as legacy query_business_checking: %s', async (_n, args) => {
    const legacy = await mcpOk('query_business_checking', args, { profile: 'legacy' })
    const v2 = await list(args)
    expect(slugs(v2).sort()).toEqual(legacy.data.map((r: any) => r.listing_slug).sort())
    expect(v2.total_matches).toBe(legacy.data.length)
  })

  it('entity_types_accepted is all-of against the table (cross-check)', async () => {
    const { data } = await db.from('business_deposit_accounts').select('listing_slug, entity_types_accepted, listing_status, product_type')
    const expected = (data ?? [])
      .filter((a) => a.listing_status === 'active' && a.product_type === 'checking')
      .filter((a) => ['sole_prop', 'nonprofit'].every((t) => (a.entity_types_accepted as string[]).includes(t)))
      .map((a) => a.listing_slug)
      .sort()
    expect(slugs(await list({ entity_types_accepted: ['sole_prop', 'nonprofit'] })).sort()).toEqual(expected)
  })

  it('boolean/numeric hard filters agree with the table (rtp_supported, free_transactions_min, apy_min)', async () => {
    const act = new Map((await activeListings()).map((l) => [l.id, l.listing_slug]))
    const { data } = await db.from('business_checking_details').select('listing_id, rtp_supported, free_transactions_per_month, apy_max')
    const rows = (data ?? []).filter((d) => act.has(d.listing_id))
    const pick = (f: (d: any) => boolean) => rows.filter(f).map((d) => act.get(d.listing_id)!).sort()
    expect(slugs(await list({ rtp_supported: true })).sort()).toEqual(pick((d) => d.rtp_supported === true))
    expect(slugs(await list({ free_transactions_min: 20 })).sort()).toEqual(pick((d) => (d.free_transactions_per_month ?? -1) >= 20))
    expect(slugs(await list({ apy_min: 0.02 })).sort()).toEqual(pick((d) => (d.apy_max ?? -1) >= 0.02))
  })

  it('every v2 response is built from keys only (no affiliate names)', async () => {
    expect(deepKeys(await list({ fields: ['plan_tiers'] })).filter((k) => /affiliate|tracker/.test(k))).toEqual([])
  })
})
