import { describe, it, expect } from 'vitest'

// Dynamic imports so each test fails individually while src/lib/tag-response.ts does not exist yet.
const mod = () => import('../lib/tag-response')
const tags = { src: 'mcp', qr: '22222222-2222-4222-8222-222222222222' }
const tagged = (slug: string, extra = '') => `https://bancadia.com/go/${slug}?src=mcp&qr=${tags.qr}${extra}`
const SHAPES: Record<string, () => any> = {
  list_business_checking: () => ({
    rows: [{ listing_slug: 'a', application_url: '/go/a/x' }, { listing_slug: 'b', application_url: '/go/b/x' }],
    matches_overview: [{ slug: 'a', name: 'A' }, { slug: 'c', name: 'C' }],
    possible_matches: [{ slug: 'd', name: 'D', snippet: 's' }],
  }),
  search_facts: () => ({
    hits: [{ slug: 'a', application_url: '/go/a/x', facts: [] }],
    no_match: [{ slug: 'b', application_url: '/go/b/x' }],
  }),
  fees_by_type: () => [{ slug: 'a', application_url: '/go/a/x', fees: [] }, { slug: 'b', application_url: '/go/b/x', fees: [] }],
  get_listing: () => ({ listings: [{ slug: 'a', application_url: '/go/a/x' }, { slug: 'b', application_url: '/go/b/x' }] }),
}
const rowsOf = (tool: string, p: any): any[] =>
  tool === 'list_business_checking' ? p.rows : tool === 'search_facts' ? [...p.hits, ...p.no_match] : tool === 'fees_by_type' ? p : p.listings

// Proves: tagResponse host-prefixes and tags every bank-bearing row of every v2 response shape, and only those.
describe('tagResponse: every response shape', () => {
  it.each(Object.keys(SHAPES))('%s: every bank row gets https://bancadia.com + src + qr', async (tool) => {
    const { tagResponse } = await mod()
    const out = tagResponse(tool, SHAPES[tool]!(), tags)
    const rows = rowsOf(tool, out)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      const u = new URL(r.application_url)
      expect(u.origin).toBe('https://bancadia.com')
      expect(u.searchParams.get('src')).toBe('mcp')
      expect(u.searchParams.get('qr')).toBe(tags.qr)
    }
  })

  it('list: matches_overview and possible_matches entries get no application_url', async () => {
    const { tagResponse } = await mod()
    const out = tagResponse('list_business_checking', SHAPES.list_business_checking!(), tags)
    expect(JSON.stringify(out.matches_overview)).not.toContain('application_url')
    expect(JSON.stringify(out.possible_matches)).not.toContain('application_url')
    expect(out.matches_overview).toEqual(SHAPES.list_business_checking!().matches_overview)
  })

  it('uses src=rest for REST', async () => {
    const { tagResponse } = await mod()
    const out = tagResponse('fees_by_type', SHAPES.fees_by_type!(), { src: 'rest', qr: tags.qr })
    expect(new URL(out[0].application_url).searchParams.get('src')).toBe('rest')
  })

  it('never overwrites a src/qr already on the stored url, and keeps other params', async () => {
    const { tagResponse } = await mod()
    const out = tagResponse('get_listing', { listings: [{ slug: 'a', application_url: '/go/a/x?src=email&utm_x=1' }] }, tags)
    const u = new URL(out.listings[0].application_url)
    expect(u.searchParams.get('src')).toBe('email')
    expect(u.searchParams.get('utm_x')).toBe('1')
    expect(u.searchParams.get('qr')).toBe(tags.qr)
  })

  it('handles empty results (nothing to tag, nothing to assert)', async () => {
    const { tagResponse } = await mod()
    expect(tagResponse('fees_by_type', [], tags)).toEqual([])
    expect(tagResponse('list_business_checking', { rows: [] }, tags)).toEqual({ rows: [] })
    expect(tagResponse('search_facts', { hits: [] }, tags)).toEqual({ hits: [] })
    expect(tagResponse('get_listing', { listings: [] }, tags)).toEqual({ listings: [] })
  })

  it('throws when a bank-bearing row has no application_url (the runtime assert runs inside tagResponse)', async () => {
    const { tagResponse } = await mod()
    expect(() => tagResponse('list_business_checking', { rows: [{ listing_slug: 'x' }] }, tags)).toThrow(/untagged application_url/)
    expect(() => tagResponse('search_facts', { hits: [], no_match: [{ slug: 'x' }] }, tags)).toThrow(/untagged application_url/)
  })
})

// Proves: the A5 runtime assert accepts correctly tagged payloads and rejects every flavor of untagged row.
describe('assertAllTagged (runtime assert)', () => {
  const okFor = (tool: string) => {
    const p = SHAPES[tool]!()
    for (const r of rowsOf(tool, p)) r.application_url = tagged(r.slug ?? r.listing_slug)
    return p
  }

  it.each(Object.keys(SHAPES))('%s: passes when every row is tagged (overview/possible_matches need no url)', async (tool) => {
    const { assertAllTagged } = await mod()
    expect(() => assertAllTagged(tool, okFor(tool))).not.toThrow()
  })

  const breakers: Array<[string, (u: string) => unknown]> = [
    ['missing', () => undefined],
    ['null', () => null],
    ['not a string', () => 42],
    ['relative path', () => '/go/a/x?src=mcp&qr=q'],
    ['wrong host', () => `https://example.com/go/a?src=mcp&qr=${tags.qr}`],
    ['no src', () => `https://bancadia.com/go/a?qr=${tags.qr}`],
    ['no qr', () => 'https://bancadia.com/go/a?src=mcp'],
    ['empty qr', () => 'https://bancadia.com/go/a?src=mcp&qr='],
    ['untagged absolute url', () => 'https://bancadia.com/go/a'],
  ]
  for (const tool of Object.keys(SHAPES))
    it.each(breakers)(`${tool}: throws for a row whose url is %s`, async (_n, make) => {
      const { assertAllTagged } = await mod()
      const p = okFor(tool)
      const target = rowsOf(tool, p)[0]
      if (make('') === undefined) delete target.application_url
      else target.application_url = make('')
      expect(() => assertAllTagged(tool, p)).toThrow(/untagged application_url/)
    })

  it('throws if only the LAST row of many is untagged', async () => {
    const { assertAllTagged } = await mod()
    const p = okFor('list_business_checking')
    p.rows.push({ listing_slug: 'z' })
    expect(() => assertAllTagged('list_business_checking', p)).toThrow(/untagged application_url/)
  })

  it('ignores matches_overview entries (they must not carry urls) but still checks rows', async () => {
    const { assertAllTagged } = await mod()
    const p = okFor('list_business_checking')
    expect(p.matches_overview[0].application_url).toBeUndefined()
    expect(() => assertAllTagged('list_business_checking', p)).not.toThrow()
  })
})
