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

import { mcpOk, rest, affiliateKeys, K } from './v2-helpers'


const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'application_url' ? undefined : v)))

// Proves: the REST envelope for each v2 route (data as before, paging and extras in meta), parity with the MCP
// tools, and that bad input is a 4xx problem+json carrying the DB's valid-values text (never a 500).
describe('v2 REST envelopes', () => {
  it('list: data is an array of rows; meta has count, request_id, filters and the paging fields', async () => {
    const r = await rest('/business-checking-listings?monthly_fee_max=0&limit=3')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.data)).toBe(true)
    expect(r.body.meta).toMatchObject({ count: 3, request_id: r.requestId, filters: { monthly_fee_max: 0, limit: 3 }, returned: 3, limit: 3 })
    expect(typeof r.body.meta.total_matches).toBe('number')
    expect(r.body.meta.next_offset).toBe(3)
    expect(typeof r.body.meta.notes).toBe('string')
    expect(r.body.meta.hint).toContain('search_facts')
    expect(r.body.meta.matches_overview).toHaveLength(r.body.meta.total_matches)
    expect(r.body.meta.excluded_by).toBeDefined()
  })

  it('list: meta.matches_overview is absent when everything fits on the page', async () => {
    const r = await rest('/business-checking-listings?limit=20')
    expect('matches_overview' in r.body.meta).toBe(false)
    expect(r.body.meta.next_offset).toBeNull()
  })

  it('list: meta carries possible_matches when an integrations filter is used', async () => {
    const r = await rest('/business-checking-listings?integrations_any=stripe&limit=20')
    expect(Array.isArray(r.body.meta.possible_matches)).toBe(true)
    expect(r.body.data.every((row: any) => Array.isArray(row.matched))).toBe(true)
  })

  it('list: query parameter encodings (arrays, booleans, numbers, min_limits) behave like the MCP arguments', async () => {
    const m = await mcpOk('list_business_checking', {
      entity_types_accepted: ['llc', 'nonprofit'], interest_bearing: true, apy_min: 0.01,
      min_limits: { sub_accounts: 12 }, sort: 'apy_max_desc', fields: ['apy_max', 'monthly_fee'],
    })
    const r = await rest('/business-checking-listings?entity_types_accepted=llc,nonprofit&interest_bearing=true&apy_min=0.01&min_limits=sub_accounts:12&sort=apy_max_desc&fields=apy_max,monthly_fee')
    expect(r.status).toBe(200)
    expect(strip(r.body.data)).toEqual(strip(m.data.rows))
    expect(r.body.meta.total_matches).toBe(m.data.total_matches)
  })

  it('facts: data is the hits array, no_match/unknown_slugs/scanned/banks_matched in meta; same hits as MCP', async () => {
    const m = await mcpOk('search_facts', { query: 'barcode', slugs: [K.found, K.mercury, 'zzz'] })
    const r = await rest(`/business-checking-listings/-/facts?query=barcode&slugs=${K.found},${K.mercury},zzz`)
    expect(r.status).toBe(200)
    expect(strip(r.body.data)).toEqual(strip(m.data.hits))
    expect(r.body.meta).toMatchObject({ count: m.data.hits.length, request_id: r.requestId, scanned: m.data.scanned, banks_matched: m.data.banks_matched, unknown_slugs: ['zzz'] })
    expect(strip(r.body.meta.no_match)).toEqual(strip(m.data.no_match))
  })

  it('fees: data is the array of banks, same as MCP', async () => {
    const m = await mcpOk('fees_by_type', { fee_types: ['cash_deposit'], slugs: [K.found, K.citibank] })
    const r = await rest(`/business-checking-listings/-/fees?fee_types=cash_deposit&slugs=${K.found},${K.citibank}`)
    expect(r.status).toBe(200)
    expect(strip(r.body.data)).toEqual(strip(m.data))
    expect(r.body.meta).toMatchObject({ count: 2, request_id: r.requestId })
  })

  it.each([['fees', 'fees'], ['features', 'features'], ['promotions', 'promotions'], ['plans', 'tiers']])(
    'sub-route /%s: data is that section array (same rows as MCP get_listing), meta.listing names the bank',
    async (route, section) => {
      // first seeded listing that has rows in this section (promotions are sparse in the seed; relay has none)
      const all = await mcpOk('get_listing', { slugs: Object.values(K).slice(0, 4), sections: [section] })
      const slug = all.data.listings.find((l: any) => l[section]?.length)?.slug ?? K.relay
      const m = await mcpOk('get_listing', { slugs: [slug], sections: [section] })
      const r = await rest(`/business-checking-listings/${slug}/${route}`)
      expect(r.status).toBe(200)
      expect(Array.isArray(r.body.data)).toBe(true)
      expect(r.body.data.length).toBeGreaterThan(0)
      expect(r.body.data).toEqual(m.data.listings[0][section])
      expect(r.body.meta).toMatchObject({ count: r.body.data.length, request_id: r.requestId, listing: { listing_slug: slug } })
      expect(strip(r.body.meta.listing)).toEqual({ listing_slug: slug })
    }
  )

  it('sub-route on a listing with no rows in that section: data [] and the link is still there', async () => {
    // karat-style gap is seed dependent: pick any listing/section pair whose MCP section is absent
    for (const slug of Object.values(K)) {
      const m = await mcpOk('get_listing', { slugs: [slug], sections: ['promotions'] })
      if (m.data.listings[0].promotions) continue
      const r = await rest(`/business-checking-listings/${slug}/promotions`)
      expect(r.status).toBe(200)
      expect(r.body.data).toEqual([])
      expect(r.body.meta.count).toBe(0)
      expect(r.body.meta.listing.application_url).toContain('src=rest')
      return
    }
  })

  it('sub-routes take no query parameters (400), unknown slug is 404', async () => {
    for (const sub of ['fees', 'features', 'promotions', 'plans']) {
      expect((await rest(`/business-checking-listings/${K.relay}/${sub}?sections=fees`)).status).toBe(400)
      expect((await rest(`/business-checking-listings/nope-nope/${sub}`)).status).toBe(404)
    }
  })

  it('the - wildcard is never a slug: /-, /-/features, /-/promotions, /-/plans, /-/nope are 404 without touching the DB', async () => {
    for (const p of ['/business-checking-listings/-', '/business-checking-listings/-/features', '/business-checking-listings/-/promotions', '/business-checking-listings/-/plans', '/business-checking-listings/-/nope', '/business-checking/-']) {
      const r = await rest(p)
      expect(r.status, p).toBe(404)
      expect(r.body.status).toBe(404)
    }
  })

  it('removed routes are 404 (the alias reads them as unknown slugs): /compare, /facts, /fees', async () => {
    for (const p of ['/business-checking/compare', '/business-checking/facts', '/business-checking/fees']) {
      expect((await rest(p)).status, p).toBe(404)
    }
  })

  it('deprecated aliases return the same body (modulo request ids and tags) plus Deprecation and successor Link headers', async () => {
    const norm = (t: string) => JSON.parse(t.replace(/qr=[0-9a-f-]{36}/g, 'qr=X').replace(/"request_id":"[^"]+"/g, '"request_id":"X"'))
    const pairs: Array<[string, string, string]> = [
      ['/business-checking?limit=3', '/business-checking-listings?limit=3', '</v1/business-checking-listings>; rel="successor-version"'],
      [`/business-checking/${K.relay}?sections=fees`, `/business-checking-listings/${K.relay}?sections=fees`, `</v1/business-checking-listings/${K.relay}>; rel="successor-version"`],
    ]
    for (const [oldPath, newPath, link] of pairs) {
      const [o, n] = [await rest(oldPath), await rest(newPath)]
      expect(o.status).toBe(200)
      expect(o.headers.get('Deprecation')).toBe('true')
      expect(o.headers.get('Link')).toContain(link)
      expect(n.headers.get('Deprecation')).toBeNull()
      expect(norm(o.text)).toEqual(norm(n.text))
    }
    expect((await rest('/business-checking?nope=1')).status).toBe(400)
  })

  it('single listing: data is the one listing object (not an array), count 1, optional sections', async () => {
    const r = await rest(`/business-checking-listings/${K.relay}?sections=fees,tiers`)
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.data)).toBe(false)
    expect(r.body.data.slug).toBe(K.relay)
    expect(r.body.data.fees.length).toBeGreaterThan(0)
    expect(r.body.data.tiers.length).toBeGreaterThan(0)
    expect(r.body.meta).toMatchObject({ count: 1, request_id: r.requestId })
  })

  it('single listing, default sections: summary and tiers', async () => {
    const r = await rest(`/business-checking-listings/${K.found}`)
    expect(r.body.data.summary).toBeDefined()
    expect(r.body.data.detail_has.length).toBeGreaterThan(0)
  })

  it('no REST response names affiliate status', async () => {
    for (const p of ['/business-checking-listings?limit=20', '/business-checking-listings/-/facts?query=cash', '/business-checking-listings/-/fees?fee_types=cash_deposit', `/business-checking-listings/${K.lili}`]) {
      const r = await rest(p)
      expect(r.status, p).toBe(200)
      expect(affiliateKeys(r.body)).toEqual([])
    }
  })
})

describe('v2 REST errors are 4xx problem+json with the valid values', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['bad enum from the DB', '/business-checking-listings?insurance_type=bogus', /fdic.*ncua/s],
    ['bad entity type', '/business-checking-listings?entity_types_accepted=zzz', /sole_prop/],
    ['bad state', '/business-checking-listings?available_states=ZZ', /NY/],
    ['bad integration', '/business-checking-listings?integrations_any=nopeware', /quickbooks/],
    ['bad min_limits key', '/business-checking-listings?min_limits=nope:1', /free_cash_deposit_usd/],
    ['bad field', '/business-checking-listings?fields=zzz', /apy_max/],
    ['bad sort', '/business-checking-listings?sort=zzz', /monthly_fee_asc/],
    ['non-integer limit', '/business-checking-listings?limit=abc', /limit/],
    ['fractional limit', '/business-checking-listings?limit=2.5', /limit/],
    ['unknown parameter', '/business-checking-listings?nope=1', /nope/],
    ['bad fee type', '/business-checking-listings/-/fees?fee_types=zzz', /cash_deposit/],
    ['too many fee types', '/business-checking-listings/-/fees?fee_types=cash_deposit,overdraft,dormancy,other,returned_item,stop_payment', /At most 5/],
    ['missing fee_types', '/business-checking-listings/-/fees', /fee_types/],
    ['missing query', '/business-checking-listings/-/facts', /query/],
    ['bad topic', '/business-checking-listings/-/facts?query=fee&topic=zzz', /payment_rails/],
    ['bad section', `/business-checking-listings/${K.found}?sections=zzz`, /promotions/],
  ]
  it.each(cases)('%s -> 400', async (_n, path, re) => {
    const r = await rest(path)
    expect(r.status).toBe(400)
    expect(r.body.status).toBe(400)
    expect(r.body.detail).toMatch(re)
    // the v2 routes know these parameters: it must be the value that is rejected, not the parameter name
    if (!path.includes('nope=1')) expect(r.body.detail).not.toMatch(/^Unknown query parameter/)
  })

  it('unknown listing slug -> 404', async () => {
    const r = await rest('/business-checking-listings/no-such-listing')
    expect(r.status).toBe(404)
  })
})
