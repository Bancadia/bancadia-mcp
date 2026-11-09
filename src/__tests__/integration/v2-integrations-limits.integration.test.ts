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

import { mcpOk, mcpErr, rpc, db, activeListings, expectTaggedUrl, K } from './v2-helpers'


const list = (args: Record<string, unknown> = {}) => mcpOk('list_business_checking', { limit: 20, ...args }).then((r) => r.data)
const slugs = (d: any) => d.rows.map((r: any) => r.listing_slug) as string[]

// The join table is the oracle: listing slugs (active checking) that have a feature row tagged with `integration`.
async function slugsWith(integration: string): Promise<Set<string>> {
  const act = new Map((await activeListings()).map((l) => [l.id, l.listing_slug]))
  const { data: joins } = await db.from('business_deposit_feature_integrations').select('feature_id, integration_slug').eq('integration_slug', integration)
  const ids = (joins ?? []).map((j) => j.feature_id)
  const { data: feats } = await db.from('business_deposit_account_features').select('id, listing_id').in('id', ids)
  return new Set((feats ?? []).map((f) => act.get(f.listing_id)).filter((s): s is string => !!s))
}

// Proves: integrations_any / integrations_all filter by the tagged join table (not by flags or text), aliases
// resolve, and results explain themselves with matched[] and possible_matches.
describe('v2 integrations filters', () => {
  it('integrations_any [quickbooks] equals the join-table cross-check', async () => {
    const expected = [...(await slugsWith('quickbooks'))].sort()
    expect(expected.length).toBeGreaterThan(5)
    const d = await list({ integrations_any: ['quickbooks'] })
    expect(slugs(d).sort()).toEqual(expected)
    expect(d.total_matches).toBe(expected.length)
  })

  it('integrations_any [quickbooks, gusto] is the union; integrations_all is the intersection', async () => {
    const [qb, gusto] = [await slugsWith('quickbooks'), await slugsWith('gusto')]
    const union = [...new Set([...qb, ...gusto])].sort()
    const inter = [...qb].filter((s) => gusto.has(s)).sort()
    expect(slugs(await list({ integrations_any: ['quickbooks', 'gusto'] })).sort()).toEqual(union)
    expect(slugs(await list({ integrations_all: ['quickbooks', 'gusto'] })).sort()).toEqual(inter)
    expect(inter.length).toBeGreaterThan(0)
    expect(inter.length).toBeLessThan(union.length)
  })

  it('alias qbo (any case) resolves to quickbooks', async () => {
    const qb = slugs(await list({ integrations_any: ['quickbooks'] })).sort()
    expect(slugs(await list({ integrations_any: ['qbo'] })).sort()).toEqual(qb)
    expect(slugs(await list({ integrations_any: ['QBO'] })).sort()).toEqual(qb)
    expect(slugs(await list({ integrations_any: ['QuickBooks Online'] })).sort()).toEqual(qb)
  })

  it('rows carry matched[] with integration, plan, note (<=100 chars) and an optional connection_method', async () => {
    const d = await list({ integrations_any: ['qbo'] })
    for (const row of d.rows) {
      expect(row.matched.length).toBeGreaterThan(0)
      for (const m of row.matched) {
        expect(m.integration).toBe('quickbooks')
        expect(typeof m.plan).toBe('string')
        expect(typeof m.note).toBe('string')
        expect(m.note.length).toBeLessThanOrEqual(100)
        if (m.connection_method !== undefined) expect(['native', 'third_party', 'none']).toContain(m.connection_method)
      }
    }
  })

  it('pinned facts: Relay QuickBooks is native on all plans; Found QuickBooks has no stated method', async () => {
    const d = await list({ integrations_any: ['quickbooks'] })
    const relay = d.rows.find((r: any) => r.listing_slug === K.relay).matched.find((m: any) => m.integration === 'quickbooks')
    expect(relay).toMatchObject({ connection_method: 'native', plan: 'all plans' })
    const found = d.rows.find((r: any) => r.listing_slug === K.found).matched.find((m: any) => m.integration === 'quickbooks')
    expect(found.plan).toBe('all plans')
    expect(found.connection_method).toBeUndefined()
  })

  it('possible_matches is present only with an integrations filter, equals the DB result, and lists banks not in rows', async () => {
    const plain = await list()
    expect('possible_matches' in plain).toBe(false)
    const d = await list({ integrations_any: ['stripe'] })
    const direct = await rpc('list_business_checking', { p_filters: { integrations_any: ['stripe'] }, p_limit: 20, p_offset: 0 })
    expect(Array.isArray(d.possible_matches)).toBe(true)
    expect(d.possible_matches.map(({ application_url, ...p }: any) => p)).toEqual(direct.possible_matches.map(({ application_url, ...p }: any) => p))
    expect(d.possible_matches.length).toBeGreaterThan(0) // Ramp mentions Stripe in untagged text
    for (const p of d.possible_matches) {
      expect(Object.keys(p).sort()).toEqual(['application_url', 'name', 'slug', 'snippet'])
      expect(slugs(d)).not.toContain(p.slug)
      expectTaggedUrl(p.application_url, 'mcp')
    }
    expect(d.possible_matches.length).toBeLessThanOrEqual(3)
  })

  it('integrations filter combines with other hard filters (AND)', async () => {
    const qb = await slugsWith('quickbooks')
    const d = await list({ integrations_any: ['quickbooks'], monthly_fee_max: 0 })
    const zero = new Set((await activeListings()).filter((l) => l.monthly_fee <= 0).map((l) => l.listing_slug))
    expect(slugs(d).sort()).toEqual([...qb].filter((s) => zero.has(s)).sort())
  })
})

// Proves: min_limits uses >= on any plan, reports the best qualifying value and its plan, and rejects unknown keys.
describe('v2 min_limits', () => {
  async function bestSubAccounts() {
    const act = new Map((await activeListings()).map((l) => [l.id, l.listing_slug]))
    const { data } = await db.from('business_deposit_account_features').select('listing_id, value, limit_key').eq('limit_key', 'sub_accounts')
    const best = new Map<string, number>()
    for (const f of data ?? []) {
      const s = act.get(f.listing_id)
      if (s && f.value !== null) best.set(s, Math.max(best.get(s) ?? 0, Number(f.value)))
    }
    return best
  }

  it('sub_accounts >= 12 matches exactly the listings whose best sub_accounts value is >= 12 (table cross-check)', async () => {
    const best = await bestSubAccounts()
    const expected = [...best].filter(([, v]) => v >= 12).map(([s]) => s).sort()
    const d = await list({ min_limits: { sub_accounts: 12 } })
    expect(slugs(d).sort()).toEqual(expected)
    for (const row of d.rows) {
      const ml = row.matched_limits.find((x: any) => x.key === 'sub_accounts')
      expect(ml.value).toBe(best.get(row.listing_slug))
      expect(typeof ml.plan).toBe('string')
    }
  })

  it('pinned values: Found 20 (all plans), Relay 50 (Scale), Bluevine 50 (Premier), Mercury 100', async () => {
    const d = await list({ min_limits: { sub_accounts: 12 } })
    const ml = (s: string) => d.rows.find((r: any) => r.listing_slug === s).matched_limits[0]
    expect(ml(K.found)).toMatchObject({ key: 'sub_accounts', value: 20, plan: 'all plans' })
    expect(ml(K.relay)).toMatchObject({ value: 50, plan: 'Scale' })
    expect(ml(K.bluevine)).toMatchObject({ value: 50, plan: 'Premier' })
    expect(ml(K.mercury).value).toBe(100)
  })

  it('has >= semantics: a threshold equal to a stored value still matches it, one above does not', async () => {
    expect(slugs(await list({ min_limits: { sub_accounts: 50 } }))).toEqual(expect.arrayContaining([K.bluevine, K.relay, K.mercury]))
    const above = slugs(await list({ min_limits: { sub_accounts: 51 } }))
    expect(above).toContain(K.mercury)
    expect(above).not.toContain(K.bluevine)
    expect(above).not.toContain(K.relay)
    expect((await list({ min_limits: { sub_accounts: 101 } })).total_matches).toBe(0)
  })

  it('keys are case-insensitive and all keys must match', async () => {
    const both = await list({ min_limits: { SUB_ACCOUNTS: 12, free_cash_deposit_usd: 5000 } })
    const subs = slugs(await list({ min_limits: { sub_accounts: 12 } }))
    const cash = slugs(await list({ min_limits: { free_cash_deposit_usd: 5000 } }))
    expect(slugs(both).sort()).toEqual(subs.filter((s) => cash.includes(s)).sort())
  })

  it('an unknown key is an invalid-params error listing the valid keys', async () => {
    const e = await mcpErr('list_business_checking', { min_limits: { nope: 1 } })
    expect(e.code).toBe(-32602)
    expect(e.message).toMatch(/sub_accounts.*|free_wires/s)
  })
})
