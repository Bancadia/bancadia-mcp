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

import { mcpOk, mcpErr, rpc, db, stripInternal, deepKeys, K } from './v2-helpers'


const fees = (args: Record<string, unknown>) => mcpOk('fees_by_type', args).then((r) => r.data as any[])
const listing = (args: Record<string, unknown>) => mcpOk('get_listing', args).then((r) => r.data)
const bank = (arr: any[], slug: string) => arr.find((b) => b.slug === slug)

// Proves: fees_by_type returns the structured fee rows the DB holds (pinned cash-deposit facts), resolves plans,
// caps at 3 types, and the Worker unwraps the DB's {results, returned_ids} into the array of banks.
describe('v2 fees_by_type', () => {
  const four = [K.found, K.lili, K.citibank, K.chase]

  it('cash_deposit pinned values: Found $2.00 per_transaction with 1 free per month', async () => {
    const f = bank(await fees({ fee_types: ['cash_deposit'], slugs: four }), K.found).fees[0]
    expect(f).toMatchObject({ fee_type: 'cash_deposit', amount: 2, fee_unit: 'per_transaction', amount_status: 'set', plan: 'all plans' })
    expect(f.free_allowance).toEqual({ amount: 1, unit: 'count', period: 'month' })
  })

  it('cash_deposit pinned values: Citi $0.35 per_100 with $5,000 free per month', async () => {
    const f = bank(await fees({ fee_types: ['cash_deposit'], slugs: four }), K.citibank).fees[0]
    expect(f).toMatchObject({ amount: 0.35, fee_unit: 'per_100', amount_status: 'set' })
    expect(f.free_allowance).toEqual({ amount: 5000, unit: 'usd', period: 'month' })
  })

  it('cash_deposit pinned values: Lili is free; Chase is 0.30 percent with $5,000 free', async () => {
    const res = await fees({ fee_types: ['cash_deposit'], slugs: four })
    expect(bank(res, K.lili).fees[0]).toMatchObject({ amount: 0, amount_status: 'free' })
    const chase = bank(res, K.chase).fees[0]
    expect(chase).toMatchObject({ amount: 0.3, fee_unit: 'percent', amount_status: 'set' })
    expect(chase.free_allowance).toEqual({ amount: 5000, unit: 'usd', period: 'month' })
  })

  it('plan resolution: default gives the default plan rows; plan Grow (any case) gives the Grow row', async () => {
    const def = bank(await fees({ fee_types: ['monthly_maintenance'], slugs: [K.relay] }), K.relay).fees
    expect(def).toHaveLength(1)
    expect(def[0]).toMatchObject({ plan: 'all plans', amount: 0 })
    const grow = bank(await fees({ fee_types: ['monthly_maintenance'], slugs: [K.relay], plan: 'gRoW' }), K.relay).fees
    expect(grow).toHaveLength(1)
    expect(grow[0]).toMatchObject({ plan: 'Grow', amount: 30 })
  })

  it('a plan the bank does not have silently falls back to its plan-less rows', async () => {
    const r = bank(await fees({ fee_types: ['cash_deposit'], slugs: [K.found], plan: 'no-such-plan' }), K.found)
    expect(r.fees[0].plan).toBe('all plans')
  })

  it('accepts 3 fee types, rejects 4 and 0', async () => {
    expect((await fees({ fee_types: ['cash_deposit', 'overdraft', 'dormancy'], slugs: four })).length).toBe(4)
    const e4 = await mcpErr('fees_by_type', { fee_types: ['cash_deposit', 'overdraft', 'dormancy', 'other'] })
    expect(e4.code).toBe(-32602)
    expect(e4.message).toMatch(/At most 3/)
    expect((await mcpErr('fees_by_type', { fee_types: [] })).code).toBe(-32602)
  })

  it('unwraps .results: the MCP payload is the bare array of banks, with no returned_ids and no ids', async () => {
    const r = await mcpOk('fees_by_type', { fee_types: ['cash_deposit'] })
    expect(Array.isArray(r.data)).toBe(true)
    expect(r.text).not.toContain('returned_ids')
    for (const b of r.data) expect(Object.keys(b).sort()).toEqual(['application_url', 'fees', 'name', 'slug'])
  })

  it('unscoped: only banks that have a matching fee; scoped: every active requested bank', async () => {
    const un = await fees({ fee_types: ['cash_deposit'] })
    for (const b of un) expect(b.fees.length).toBeGreaterThan(0)
    const scoped = await fees({ fee_types: ['dormancy'], slugs: [K.mercury, K.relay, 'zzz'] })
    expect(scoped.map((b) => b.slug).sort()).toEqual([K.mercury, K.relay].sort())
  })

  it('equals the DB function output (results only) apart from tagged links', async () => {
    const direct = (await rpc('fees_by_type', { p_fee_types: ['cash_deposit'], p_slugs: four, p_plan: 'default' })).results
    const out = await fees({ fee_types: ['cash_deposit'], slugs: four })
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'application_url' ? undefined : v)))
    expect(strip(out)).toEqual(strip(direct))
    expect(deepKeys(out)).not.toContain('returned_ids')
  })
})

// Proves: get_listing serves up to 4 listings in one call, only the requested sections, with detail_has equal to
// the real row counts, plan names on fees, and expired promotions hidden (but still stored).
describe('v2 get_listing', () => {
  it('returns several listings in one call, in input order, each with detail_has', async () => {
    const slugs = [K.relay, K.found, K.chase]
    const d = await listing({ slugs })
    expect(d.listings.map((l: any) => l.slug)).toEqual(slugs)
    for (const l of d.listings) expect(Array.isArray(l.detail_has)).toBe(true)
  })

  it('rejects more than 4 slugs (error says at most 4); 4 is fine; unknown slugs go to not_found', async () => {
    const five = [K.relay, K.found, K.chase, K.lili, K.mercury]
    const e = await mcpErr('get_listing', { slugs: five })
    expect(e.code).toBe(-32602)
    expect(e.message).toMatch(/At most 4/)
    expect((await listing({ slugs: five.slice(0, 4) })).listings).toHaveLength(4)
    const nf = await listing({ slugs: [K.found, 'nope'] })
    expect(nf.not_found).toEqual(['nope'])
    expect(nf.listings).toHaveLength(1)
  })

  it('returns only the requested sections (plus slug, application_url and detail_has)', async () => {
    const d = await listing({ slugs: [K.relay], sections: ['fees'] })
    expect(Object.keys(d.listings[0]).sort()).toEqual(['application_url', 'detail_has', 'fees', 'slug'])
    const def = await listing({ slugs: [K.relay] })
    expect(Object.keys(def.listings[0]).sort()).toEqual(['application_url', 'detail_has', 'slug', 'summary', 'tiers'])
  })

  it('detail_has equals the real row counts for every known listing (tiers, fees, features, visible promotions)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const d = await listing({ slugs: [K.relay, K.found, K.chase, K.bluevine] })
    for (const l of d.listings) {
      const { data: acct } = await db.from('business_deposit_accounts').select('id').eq('listing_slug', l.slug).single()
      const id = acct!.id
      const count = async (table: string) => (await db.from(table as never).select('*', { count: 'exact', head: true }).eq('listing_id', id)).count ?? 0
      const promos = await db.from('business_deposit_promotions').select('expiry_date').eq('listing_id', id)
      const visible = (promos.data ?? []).filter((p) => p.expiry_date === null || p.expiry_date >= today).length
      const expected = Object.entries({
        tiers: await count('business_deposit_plan_tiers'),
        fees: await count('business_deposit_fees'),
        features: await count('business_deposit_account_features'),
        promotions: visible,
      }).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`)
      expect([...l.detail_has].sort()).toEqual(expected.sort())
    }
  })

  it('fees carry plan names ("all plans" or a real plan), including Relay\'s Grow plan', async () => {
    const d = await listing({ slugs: [K.relay], sections: ['fees'] })
    const plans = new Set(d.listings[0].fees.map((f: any) => f.plan))
    expect(d.listings[0].fees.every((f: any) => typeof f.plan === 'string')).toBe(true)
    expect(plans.has('all plans')).toBe(true)
    expect(plans.has('Grow')).toBe(true)
  })

  it('Chase: expired promotions are hidden from the API but still in the table', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const { data: acct } = await db.from('business_deposit_accounts').select('id').eq('listing_slug', K.chase).single()
    const { data: rows } = await db.from('business_deposit_promotions').select('expiry_date, bonus_amount').eq('listing_id', acct!.id)
    expect(rows).toHaveLength(4) // the table keeps expired rows
    const visible = rows!.filter((p) => p.expiry_date === null || p.expiry_date >= today)
    expect(visible.length).toBeLessThan(4) // premise: some are expired today
    const d = await listing({ slugs: [K.chase], sections: ['promotions'] })
    const promos = d.listings[0].promotions
    expect(promos).toHaveLength(visible.length)
    for (const p of promos) expect(p.expiry_date === undefined || p.expiry_date >= today).toBe(true)
    expect(d.listings[0].detail_has).toContain(`promotions:${visible.length}`)
    // same rule on list rows
    const l = await mcpOk('list_business_checking', { fields: ['promotions'], limit: 20 })
    const row = l.data.rows.find((r: any) => r.listing_slug === K.chase)
    expect(row.promotions).toHaveLength(visible.length)
  })

  it('equals the DB function output (listings and not_found) apart from tagged links', async () => {
    const direct = stripInternal(await rpc('get_listing_sections', { p_slugs: [K.found, 'nope'], p_sections: ['summary', 'tiers', 'features'] }))
    const out = (await mcpOk('get_listing', { slugs: [K.found, 'nope'], sections: ['summary', 'tiers', 'features'] })).data
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'application_url' ? undefined : v)))
    expect(strip(out)).toEqual(strip(direct))
  })
})
