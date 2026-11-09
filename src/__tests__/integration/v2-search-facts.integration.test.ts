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

import { mcpOk, mcpErr, rpc, stripInternal, K } from './v2-helpers'


const search = (args: Record<string, unknown>) => mcpOk('search_facts', args).then((r) => r.data)

// Proves: search_facts caps (per bank, banks, snippet length), topic filtering, scoped no_match, one link per
// bank, and that fee text is searchable, all as the DB function does it.
describe('v2 search_facts', () => {
  it('per_bank caps snippets per bank (1, 5, and 99 clamps to 5)', async () => {
    for (const [per_bank, cap] of [[1, 1], [5, 5], [99, 5]] as const) {
      const d = await search({ query: 'wire', per_bank, max_banks: 20 })
      expect(d.hits.length).toBeGreaterThan(1)
      for (const h of d.hits) expect(h.facts.length).toBeLessThanOrEqual(cap)
    }
    const many = await search({ query: 'wire', per_bank: 5, max_banks: 20 })
    expect(many.hits.some((h: any) => h.facts.length > 1)).toBe(true)
  })

  it('max_banks caps hits but banks_matched reports the pre-cap count', async () => {
    const all = await search({ query: 'wire', max_banks: 20 })
    expect(all.banks_matched).toBeGreaterThan(2)
    expect(all.hits).toHaveLength(all.banks_matched)
    const two = await search({ query: 'wire', max_banks: 2 })
    expect(two.hits).toHaveLength(2)
    expect(two.banks_matched).toBe(all.banks_matched)
  })

  it('max_chars bounds every snippet; below the minimum it clamps to 40', async () => {
    const d = await search({ query: 'wire', max_chars: 60, per_bank: 5, max_banks: 20 })
    const lens = d.hits.flatMap((h: any) => h.facts.map((f: any) => f.snippet.length))
    expect(lens.length).toBeGreaterThan(0)
    expect(Math.max(...lens)).toBeLessThanOrEqual(60)
    const tiny = await search({ query: 'wire', max_chars: 5, per_bank: 5, max_banks: 20 })
    expect(Math.max(...tiny.hits.flatMap((h: any) => h.facts.map((f: any) => f.snippet.length)))).toBeLessThanOrEqual(40)
  })

  it('topic filters facts to that topic (fees; upper case too)', async () => {
    for (const topic of ['fees', 'CASH_HANDLING']) {
      const d = await search({ query: 'cash deposit', topic, max_banks: 20, per_bank: 5 })
      expect(d.hits.length).toBeGreaterThan(0)
      for (const h of d.hits) for (const f of h.facts) expect(f.topic).toBe(topic.toLowerCase())
    }
  })

  it('searches fee text: the Found cash deposit fee row is found under topic fees', async () => {
    const d = await search({ query: 'free cash deposit', slugs: [K.found], topic: 'fees' })
    expect(d.hits).toHaveLength(1)
    expect(d.hits[0].slug).toBe(K.found)
    expect(d.hits[0].facts.some((f: any) => f.snippet.includes('$2.00'))).toBe(true)
  })

  it('scoped queries report requested banks with no hit in no_match (slug, name, application_url), disjoint from hits', async () => {
    const d = await search({ query: 'barcode', slugs: [K.found, K.mercury, K.citibank, 'zzz-not-a-listing'] })
    expect(d.hits.map((h: any) => h.slug)).toContain(K.found)
    expect(d.no_match.map((n: any) => n.slug).sort()).toEqual([K.citibank, K.mercury].sort())
    for (const n of d.no_match) expect(Object.keys(n).sort()).toEqual(['application_url', 'name', 'slug'])
    expect(d.unknown_slugs).toEqual(['zzz-not-a-listing'])
    expect(d.scanned).toBe(3)
  })

  it('unscoped queries have no no_match and no unknown_slugs', async () => {
    const d = await search({ query: 'wire' })
    expect('no_match' in d).toBe(false)
    expect('unknown_slugs' in d).toBe(false)
  })

  it('each bank appears once with one application_url; facts carry no url of their own', async () => {
    const d = await search({ query: 'cash deposit', per_bank: 5, max_banks: 20 })
    const slugs = d.hits.map((h: any) => h.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const h of d.hits) {
      expect(typeof h.application_url).toBe('string')
      for (const f of h.facts) expect(f.application_url).toBeUndefined()
    }
  })

  it('equals the DB function output apart from returned_ids and the tagged links', async () => {
    const direct = stripInternal(await rpc('search_listing_facts', { p_query: 'overdraft', p_slugs: [K.mercury, K.chase], p_topic: null, p_per_bank: 1, p_max_banks: 10, p_max_chars: 160 }))
    const d = await search({ query: 'overdraft', slugs: [K.mercury, K.chase], per_bank: 1, max_chars: 160 })
    const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'application_url' ? undefined : v)))
    expect(strip(d)).toEqual(strip(direct))
  })

  it('an empty query is a -32602 error mentioning the query', async () => {
    const e = await mcpErr('search_facts', { query: '' })
    expect(e.code).toBe(-32602)
    expect(e.message).toMatch(/query/i)
  })

  it('a query of only stop words is a -32602 error', async () => {
    const e = await mcpErr('search_facts', { query: 'the' })
    expect(e.code).toBe(-32602)
    expect(e.message).toMatch(/searchable/i)
  })
})
