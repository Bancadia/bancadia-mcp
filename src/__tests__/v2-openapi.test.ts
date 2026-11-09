import { describe, it, expect } from 'vitest'
import { buildOpenApi } from '../lib/openapi'
import v2Manifest from '../../docs/v2-tool-manifest.json'
import openapiYaml from '../../openapi.yaml?raw'

// Absent until Phase 2B generates it; import.meta.glob does not fail at transform time when the file is missing.
const checkedIn = Object.values(import.meta.glob('../../docs/openapi-rest.json', { eager: true, import: 'default' }))[0] as any
const spec = buildOpenApi() as any
const tool = (name: string) => (v2Manifest.tools.find((t) => t.name === name) as any).inputSchema
const paramNames = (path: string) => (spec.paths[path]?.get?.parameters ?? []).map((p: any) => p.name).sort()

// Proves: the REST OpenAPI document is generated for all five v2 routes, mirrors the v2 tool schemas, and the
// checked-in copy (docs/openapi-rest.json, printed by scripts/print-openapi.ts) has not drifted from the generator.
describe('REST OpenAPI (v2)', () => {
  it('the checked-in docs/openapi-rest.json equals the generated document (no drift)', () => {
    expect(checkedIn, 'docs/openapi-rest.json must exist (npx tsx scripts/print-openapi.ts > docs/openapi-rest.json)').toBeDefined()
    expect(checkedIn).toEqual(JSON.parse(JSON.stringify(spec)))
  })

  it('has the ten operations: 8 resource routes and the 2 deprecated aliases', () => {
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/business-checking', '/business-checking-listings', '/business-checking-listings/-/facts', '/business-checking-listings/-/fees',
      '/business-checking-listings/{listing_slug}', '/business-checking-listings/{listing_slug}/features', '/business-checking-listings/{listing_slug}/fees',
      '/business-checking-listings/{listing_slug}/plans', '/business-checking-listings/{listing_slug}/promotions', '/business-checking/{listing_slug}',
    ])
    const ids = Object.values(spec.paths).map((p: any) => p.get.operationId)
    expect(new Set(ids).size).toBe(10)
  })

  it('only the two old aliases are deprecated, and they point at their successors', () => {
    const dep = Object.entries(spec.paths).filter(([, p]: any) => p.get.deprecated).map(([k]) => k).sort()
    expect(dep).toEqual(['/business-checking', '/business-checking/{listing_slug}'])
    expect(spec.paths['/business-checking'].get.description).toContain('GET /business-checking-listings')
    expect(spec.paths['/business-checking/{listing_slug}'].get.description).toContain('/business-checking-listings/{listing_slug}')
  })

  it('sub-resource routes take only the path parameter; the wildcard is documented', () => {
    for (const r of ['fees', 'features', 'promotions', 'plans'])
      expect(paramNames(`/business-checking-listings/{listing_slug}/${r}`)).toEqual(['listing_slug'])
    expect(paramNames('/business-checking-listings/{listing_slug}')).toEqual(['listing_slug', 'sections'])
    const text = JSON.stringify(spec)
    expect(text).toContain('Use - in place of {listing_slug} to read across all listings')
    expect(spec.paths['/business-checking-listings/-/fees'].get.description).toContain('Use - in place of {listing_slug}')
  })

  it.each([
    ['/business-checking-listings', 'list_business_checking'],
    ['/business-checking', 'list_business_checking'],
    ['/business-checking-listings/-/facts', 'search_facts'],
    ['/business-checking-listings/-/fees', 'fees_by_type'],
  ])('%s query parameters equal the %s tool schema properties, both directions', (path, toolName) => {
    expect(paramNames(path)).toEqual(Object.keys(tool(toolName).properties).sort())
  })

  it('every operation documents 200 with an example, and the 400/401/429/500 problem responses', () => {
    expect(Object.keys(spec.paths)).toHaveLength(10)
    for (const p of Object.values(spec.paths) as any[]) {
      const op = p.get
      expect(op.responses['200'].content['application/json'].example).toBeDefined()
      for (const s of ['400', '401', '429', '500']) expect(op.responses[s].content['application/problem+json'].schema.$ref).toBe('#/components/schemas/Problem')
    }
  })

  it('the list operation documents paging (limit default 7, max 20) and the meta fields', () => {
    const op = spec.paths['/business-checking-listings'].get
    expect(op.description).toMatch(/application_url/)
    expect(op.description).toMatch(/\b7\b/)
    expect(op.description).toMatch(/\b20\b/)
    const text = JSON.stringify(spec.components.schemas)
    for (const k of ['total_matches', 'next_offset', 'returned', 'matches_overview']) expect(text).toContain(k)
    const example = op.responses['200'].content['application/json'].example
    expect(Array.isArray(example.data)).toBe(true)
    expect(example.meta.total_matches).toBeDefined()
  })

  it('never mentions affiliate status anywhere in the document', () => {
    expect(JSON.stringify(spec)).not.toMatch(/is_affiliate|tracker_url|affiliate_/)
  })
})

// Proves: the hand-written MCP transport document lists the v2 tools next to the legacy ones.
describe('openapi.yaml (MCP transport document)', () => {
  it.each(['list_business_checking', 'search_facts', 'fees_by_type', 'get_listing'])('mentions %s', (name) => {
    expect(openapiYaml).toContain(name)
  })
})
