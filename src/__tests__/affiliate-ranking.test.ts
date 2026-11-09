import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))

vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return {
      limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }),
    }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn() }))

import app from '../index'
import { createSupabaseClient } from '../lib/supabase'
import { mockRedis, mockAnalyticsTables, withSession } from './helpers'

// Ordering contract under test:
//   1. Everything the caller asked for (hard filters, soft segment ranking) wins.
//   2. Within what's left, is_affiliate_tracked listings come first.
//   3. Existing order (monthly_fee asc, id asc) is preserved inside each group.
//   4. is_affiliate_tracked is a sort key only — never in a response.

type Row = Record<string, unknown> & { id: string; monthly_fee: number }

function listing(slug: string, over: Partial<Row> & { affiliate?: boolean } = {}): Row {
  const { affiliate = false, ...rest } = over
  return {
    id: slug,
    institution_id: `inst-${slug}`,
    listing_slug: slug,
    product_name: slug,
    monthly_fee: 0,
    minimum_opening_deposit: 0,
    entity_types_accepted: ['llc', 'sole_prop'],
    available_states: ['ALL'],
    insurance_type: 'fdic',
    application_url: `/go/${slug}`,
    listing_status: 'active',
    product_type: 'checking',
    is_affiliate_tracked: affiliate,
    institutions: { name: slug, display_name: slug },
    business_checking_details: {},
    business_deposit_plan_tiers: [],
    business_deposit_promotions: [],
    business_deposit_account_target_segments: [],
    ...rest,
  }
}

// Fixture-driven stand-in for the Supabase builder: applies the base-table
// eq/gte/lte filters and every .order() the handler asks for, so a handler
// that skips a filter (or sorts affiliates above filtered-out rows) fails here.
function fixtureChain(rows: Row[]) {
  const filters: Array<(r: Row) => boolean> = []
  const orders: Array<{ col: string; asc: boolean }> = []
  const chain: Record<string, unknown> = {}
  const add = (fn: (col: string, v: unknown) => (r: Row) => boolean) =>
    vi.fn((col: string, v: unknown) => {
      if (!col.includes('.')) filters.push(fn(col, v))
      return chain
    })
  chain.select = vi.fn(() => chain)
  chain.eq = add((c, v) => (r) => r[c] === v)
  chain.lte = add((c, v) => (r) => (r[c] as number) <= (v as number))
  chain.gte = add((c, v) => (r) => (r[c] as number) >= (v as number))
  chain.order = vi.fn((col: string, opts?: { ascending?: boolean }) => {
    orders.push({ col, asc: opts?.ascending ?? true })
    return chain
  })
  chain.then = (resolve: (v: unknown) => unknown) => {
    const out = rows
      .filter((r) => filters.every((f) => f(r)))
      .sort((a, b) => {
        for (const { col, asc } of orders) {
          const av = a[col] as number | string | boolean
          const bv = b[col] as number | string | boolean
          if (av === bv) continue
          return (av < bv ? -1 : 1) * (asc ? 1 : -1)
        }
        return 0
      })
    return Promise.resolve({ data: out, error: null }).then(resolve)
  }
  return chain
}

let tables: ReturnType<typeof mockAnalyticsTables>
function setup(rows: Row[]) {
  mockRedis()
  tables = mockAnalyticsTables(fixtureChain(rows))
  vi.mocked(createSupabaseClient).mockReturnValue({ from: tables.from } as never)
}

async function callMcp(args: Record<string, unknown> = {}) {
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk_test_token', ...withSession() },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'query_business_checking', arguments: args },
      }),
    }),
    env,
    ctx
  )
  await waitOnExecutionContext(ctx)
  const body = await res.json<{ result: { content: Array<{ text: string }> } }>()
  const text = body.result.content[0].text
  return { text, slugs: (JSON.parse(text) as Array<{ listing_slug: string }>).map((r) => r.listing_slug) }
}

const seg = (segment: string, category = 'industry_vertical') => ({ category, segment })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('affiliate-tracked ranking — query_business_checking', () => {
  it('puts affiliate-tracked listings ahead of non-affiliate ones even when they cost more', async () => {
    setup([
      listing('plain-free', { monthly_fee: 0 }),
      listing('plain-cheap', { monthly_fee: 5 }),
      listing('aff-pricey', { monthly_fee: 15, affiliate: true }),
    ])
    const { slugs } = await callMcp()
    expect(slugs).toEqual(['aff-pricey', 'plain-free', 'plain-cheap'])
  })

  it('keeps monthly_fee-ascending order inside the affiliate group and inside the rest', async () => {
    setup([
      listing('plain-b', { monthly_fee: 5 }),
      listing('aff-b', { monthly_fee: 20, affiliate: true }),
      listing('plain-a', { monthly_fee: 0 }),
      listing('aff-a', { monthly_fee: 10, affiliate: true }),
    ])
    const { slugs } = await callMcp()
    expect(slugs).toEqual(['aff-a', 'aff-b', 'plain-a', 'plain-b'])
  })

  it('leaves the order untouched when no listing is affiliate-tracked', async () => {
    setup([listing('c', { monthly_fee: 9 }), listing('a', { monthly_fee: 0 }), listing('b', { monthly_fee: 3 })])
    expect((await callMcp()).slugs).toEqual(['a', 'b', 'c'])
  })

  it('leaves fee order untouched when every listing is affiliate-tracked', async () => {
    setup([listing('b', { monthly_fee: 3, affiliate: true }), listing('a', { monthly_fee: 0, affiliate: true })])
    expect((await callMcp()).slugs).toEqual(['a', 'b'])
  })

  it('never exposes is_affiliate_tracked in the response', async () => {
    setup([listing('aff', { affiliate: true }), listing('plain')])
    const { text } = await callMcp()
    expect(text).not.toContain('affiliate')
  })

  it('records result_rank in analytics using the affiliate-first order the caller saw', async () => {
    setup([listing('plain', { monthly_fee: 0 }), listing('aff', { monthly_fee: 50, affiliate: true })])
    await callMcp()
    const rows = tables.matchInsert.mock.calls[0][0] as Array<{ listing_slug: string; result_rank: number }>
    expect(rows.map((r) => [r.listing_slug, r.result_rank])).toEqual([
      ['aff', 1],
      ['plain', 2],
    ])
  })

  describe('user filters always win over affiliate status', () => {
    it('monthly_fee_max: an affiliate over the cap is excluded, not ranked first', async () => {
      setup([
        listing('plain-free', { monthly_fee: 0 }),
        listing('aff-over-cap', { monthly_fee: 25, affiliate: true }),
        listing('aff-under-cap', { monthly_fee: 8, affiliate: true }),
      ])
      const { slugs } = await callMcp({ monthly_fee_max: 10 })
      expect(slugs).toEqual(['aff-under-cap', 'plain-free'])
    })

    it('minimum_opening_deposit_max: an affiliate over the cap is excluded', async () => {
      setup([
        listing('plain', { minimum_opening_deposit: 0 }),
        listing('aff-big-deposit', { minimum_opening_deposit: 5000, affiliate: true }),
      ])
      expect((await callMcp({ minimum_opening_deposit_max: 100 })).slugs).toEqual(['plain'])
    })

    it('insurance_type: an affiliate with a different insurer is excluded', async () => {
      setup([
        listing('plain-fdic', { insurance_type: 'fdic' }),
        listing('aff-ncua', { insurance_type: 'ncua', affiliate: true }),
      ])
      expect((await callMcp({ insurance_type: 'fdic' })).slugs).toEqual(['plain-fdic'])
    })

    it('entity_types_accepted: an affiliate that does not accept the entity type is excluded', async () => {
      setup([
        listing('plain-llc', { entity_types_accepted: ['llc'] }),
        listing('aff-corp-only', { entity_types_accepted: ['c_corp'], affiliate: true }),
      ])
      expect((await callMcp({ entity_types_accepted: ['llc'] })).slugs).toEqual(['plain-llc'])
    })

    it('available_states: an affiliate not offered in the state is excluded; ALL still matches', async () => {
      setup([
        listing('plain-all', { available_states: ['ALL'] }),
        listing('aff-tx-only', { available_states: ['TX'], affiliate: true }),
        listing('aff-ca', { available_states: ['CA'], affiliate: true }),
      ])
      expect((await callMcp({ available_states: ['CA'] })).slugs).toEqual(['aff-ca', 'plain-all'])
    })

    it('combined filters: only listings passing every filter are returned, affiliates first', async () => {
      setup([
        listing('plain-ok', { monthly_fee: 2, entity_types_accepted: ['llc'] }),
        listing('aff-ok', { monthly_fee: 9, entity_types_accepted: ['llc'], affiliate: true }),
        listing('aff-fee-fail', { monthly_fee: 40, entity_types_accepted: ['llc'], affiliate: true }),
        listing('aff-entity-fail', { monthly_fee: 1, entity_types_accepted: ['c_corp'], affiliate: true }),
        listing('plain-entity-fail', { monthly_fee: 0, entity_types_accepted: ['c_corp'] }),
      ])
      const { slugs } = await callMcp({ monthly_fee_max: 10, entity_types_accepted: ['llc'] })
      expect(slugs).toEqual(['aff-ok', 'plain-ok'])
    })

    it('returns nothing (not an affiliate fallback) when no listing satisfies the filters', async () => {
      setup([listing('aff', { monthly_fee: 30, affiliate: true }), listing('plain', { monthly_fee: 40 })])
      expect((await callMcp({ monthly_fee_max: 1 })).slugs).toEqual([])
    })
  })

  describe('soft segment ranking is a user condition, so it outranks affiliate status', () => {
    it('a better segment match beats an affiliate with no match; affiliate wins ties', async () => {
      setup([
        listing('plain-match', { monthly_fee: 10, business_deposit_account_target_segments: [seg('ecommerce')] }),
        listing('aff-no-match', { monthly_fee: 0, affiliate: true }),
        listing('aff-match', {
          monthly_fee: 20,
          affiliate: true,
          business_deposit_account_target_segments: [seg('ecommerce')],
        }),
        listing('plain-no-match', { monthly_fee: 0 }),
      ])
      const { slugs } = await callMcp({ target_industries: ['ecommerce'] })
      expect(slugs).toEqual(['aff-match', 'plain-match', 'aff-no-match', 'plain-no-match'])
    })
  })
})

// REST is always v2: ordering and filtering (affiliate-first included) moved into the DB function
// (covered by integration/v2-ordering-overview). The Worker must pass the DB order through untouched,
// forward the filters, and never expose affiliate status.
describe('affiliate-tracked ranking — REST GET /v1/business-checking (v2, DB-side ranking)', () => {
  const rpcRows = (slugs: string[]) => ({
    rows: slugs.map((s) => ({ listing_slug: s, application_url: `/go/${s}/checking` })),
    total_matches: slugs.length, returned: slugs.length, limit: 7, next_offset: null, excluded_by: {},
    returned_ids: slugs.map((s, i) => ({ id: `id-${s}`, slug: s, rank: i + 1 })),
  })
  const get = async (path: string, slugs: string[]) => {
    const rpc = vi.fn().mockResolvedValue({ data: rpcRows(slugs), error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({ rpc, from: mockAnalyticsTables({}).from } as never)
    const ctx = createExecutionContext()
    const res = await app.fetch(new Request(`http://localhost/v1${path}`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } }), env, ctx)
    await waitOnExecutionContext(ctx)
    return { res, rpc, text: await res.text() }
  }

  it('keeps the DB order and never exposes is_affiliate_tracked', async () => {
    const { res, text } = await get('/business-checking-listings', ['aff', 'plain'])
    expect(res.status).toBe(200)
    expect(text).not.toContain('affiliate')
    expect((JSON.parse(text) as { data: Array<{ listing_slug: string }> }).data.map((r) => r.listing_slug)).toEqual(['aff', 'plain'])
  })

  it('forwards filters to the DB function (it excludes filter-failing listings, affiliate or not)', async () => {
    const { rpc } = await get('/business-checking-listings?monthly_fee_max=5', ['plain'])
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_filters: { monthly_fee_max: 5 } })
  })
})
