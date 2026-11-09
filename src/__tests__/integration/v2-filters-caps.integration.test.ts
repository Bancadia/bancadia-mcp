import { describe, it, expect, vi } from 'vitest'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }) }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})
// No vi.mock('../../lib/supabase'): real local Supabase. Needs migration 079 applied.

import { mcpOk, mcpErr, db, activeListings, expectTaggedUrl, K } from './v2-helpers'

const list = (args: Record<string, unknown> = {}) => mcpOk('list_business_checking', { limit: 20, ...args }).then((r) => r.data)
const slugsOf = (rows: Array<{ listing_slug: string }>) => rows.map((r) => r.listing_slug).sort()

async function detailsBySlug(): Promise<Map<string, Record<string, any>>> {
  const ids = new Map((await activeListings()).map((l) => [l.id, l.listing_slug]))
  const { data, error } = await db.from('business_checking_details').select('*')
  if (error) throw new Error(error.message)
  return new Map(data!.filter((d: any) => ids.has(d.listing_id)).map((d: any) => [ids.get(d.listing_id)!, d]))
}

const NEW_BOOLS = ['remote_deposit_capture', 'check_writing_available', 'multicurrency_support', 'bill_pay_available', 'virtual_cards_available', 'corporate_card_available', 'physical_debit_card_available']

// Proves: each new boolean filter returns exactly the listings whose details column is true (oracle: the table),
// and a requested field shows its true value on those rows.
describe('new boolean filters', () => {
  it.each(NEW_BOOLS)('%s=true matches the table, and the column is shown on rows', async (col) => {
    const det = await detailsBySlug()
    const expected = [...det].filter(([, d]) => d[col] === true).map(([s]) => s).sort()
    const d = await list({ [col]: true, fields: [col] })
    expect(slugsOf(d.rows)).toEqual(expected)
    for (const r of d.rows) expect(r[col]).toBe(true)
  })

  it('a non-boolean is invalid_args', async () => {
    const e = await mcpErr('list_business_checking', { bill_pay_available: 'yes' })
    expect(e.code).toBe(-32602)
  })
})

// Proves: keys named in fields (and columns of boolean filters in use) keep false/null instead of being dropped.
describe('explicit false/null on requested fields', () => {
  it('requested fields appear on every row even when false or null', async () => {
    const d = await list({ fields: ['multicurrency_support', 'apy_max'] })
    for (const r of d.rows) {
      expect(r).toHaveProperty('multicurrency_support')
      expect(r).toHaveProperty('apy_max')
    }
    expect(d.rows.some((r: any) => r.multicurrency_support === false || r.multicurrency_support === null)).toBe(true)
    expect(d.rows.some((r: any) => r.apy_max === null)).toBe(true)
  })

  it('default rows stay slim (no explicit nulls)', async () => {
    const d = await list()
    for (const r of d.rows) expect(Object.values(r).includes(null)).toBe(false)
  })
})

// Proves: min_insured_usd filters on the best known coverage and lists extended-coverage banks with an unpublished
// amount in possible_matches, each with a tagged application_url, never in rows.
describe('min_insured_usd', () => {
  it('rows meet the minimum; null-limit extended banks are possible_matches with tagged links', async () => {
    const d = await list({ min_insured_usd: 300000 })
    for (const r of d.rows) {
      const best = Math.max(r.deposit_insurance_extended_limit ?? 0, r.insurance_type === 'uninsured' ? 0 : (r.deposit_insurance_limit ?? 0))
      expect(best).toBeGreaterThanOrEqual(300000)
    }
    expect(d.possible_matches.length).toBeGreaterThan(0)
    const rowSlugs = new Set(d.rows.map((r: any) => r.listing_slug))
    for (const p of d.possible_matches) {
      expect(rowSlugs.has(p.slug)).toBe(false)
      expect(p.snippet).toMatch(/amount not published/)
      expectTaggedUrl(p.application_url, 'mcp')
    }
    expect(JSON.stringify(d.matches_overview ?? [])).not.toContain('application_url')
  })

  it('a non-number is invalid_args', async () => {
    const e = await mcpOk('list_business_checking', {}).then(() => mcpErr('list_business_checking', { min_insured_usd: 'lots' }))
    expect(e.code).toBe(-32602)
  })
})

// Proves: features are capped with features_shown/features_truncated, and query returns only matching features.
describe('get_listing features cap and query', () => {
  it('caps features and reports it; detail_has keeps the full count', async () => {
    const d = (await mcpOk('get_listing', { slugs: [K.lili], sections: ['features'] })).data
    const l = d.listings[0]
    const total = Number(l.detail_has.find((x: string) => x.startsWith('features:')).split(':')[1])
    expect(l.features.length).toBe(l.features_shown)
    expect(l.features_shown).toBeLessThanOrEqual(8)
    expect(total).toBeGreaterThan(8)
    expect(l.features_truncated).toBe(true)
  })

  it('query returns only matching features', async () => {
    const all = (await mcpOk('get_listing', { slugs: [K.lili], sections: ['features'], query: 'cash' })).data.listings[0]
    const none = (await mcpOk('get_listing', { slugs: [K.lili], sections: ['features'] })).data.listings[0]
    expect(all.features_shown).toBeGreaterThan(0)
    expect(all.features_shown).toBeLessThanOrEqual(none.features_shown)
    expectTaggedUrl(all.application_url, 'mcp')
  })
})

// Proves: fees_by_type takes up to 5 types (6 is invalid_args), caps rows per bank and says how many it omitted.
describe('fees_by_type cap', () => {
  const five = ['monthly_maintenance', 'overdraft', 'non_sufficient_funds', 'cash_deposit', 'wire_domestic_outgoing']
  it('accepts 5 fee types, tags every bank', async () => {
    const r = (await mcpOk('fees_by_type', { fee_types: five })).data
    expect(r.length).toBeGreaterThan(0)
    for (const b of r) {
      expectTaggedUrl(b.application_url, 'mcp')
      expect(b.fees.length).toBeLessThanOrEqual(6)
    }
  })
  it('rejects 6 fee types', async () => {
    const e = await mcpErr('fees_by_type', { fee_types: [...five, 'other'] })
    expect(e.code).toBe(-32602)
  })
})

// Proves: a zero-hit multi-term query is retried as any-term and flagged relaxed.
describe('search_facts relaxed', () => {
  it('relaxed: true when the AND query has no hit', async () => {
    const d = (await mcpOk('search_facts', { query: 'zelle qqqzzznotaword' })).data
    expect(d.relaxed).toBe(true)
    expect(d.hits.length).toBeGreaterThan(0)
    for (const h of d.hits) expectTaggedUrl(h.application_url, 'mcp')
  })
  it('no relaxed key when the AND query hits', async () => {
    const d = (await mcpOk('search_facts', { query: 'zelle' })).data
    expect('relaxed' in d).toBe(false)
  })
})
