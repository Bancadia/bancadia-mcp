import { describe, it, expect, vi } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'

vi.mock('../lib/analytics', () => ({ recordQueryEvent: vi.fn() }))

import app from '../index'
import { buildOpenApi } from '../lib/openapi'
import { TOOLS_V2 } from '../lib/tools-v2'

const spec = buildOpenApi() as any

describe('GET /v1/openapi.json', () => {
  it('serves a parseable 3.1 document with /v1 headers and CORS', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/openapi.json'), env, createExecutionContext())
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('link')).toContain('service-desc')
    expect((await res.json() as any).openapi).toBe('3.1.0')
  })
})

describe('openapi document', () => {
  it('has the required top-level and operation fields', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.contact.email).toBeTruthy()
    expect(spec.servers[0].url).toBe('https://api.bancadia.com/v1')
    expect(spec.externalDocs.url).toContain('/docs/rest-api')
    expect(spec.security).toEqual([{}, { bearerAuth: [] }])
    expect(spec.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' })
    for (const n of ['BankRow', 'ListResponse', 'DetailResponse', 'Problem']) expect(spec.components.schemas[n]).toBeDefined()
    const ops = Object.values(spec.paths).map((p: any) => p.get)
    expect(ops.map((o: any) => o.operationId).sort()).toEqual([
      'compareBusinessCheckingFees', 'getBusinessCheckingAccount', 'getBusinessCheckingListing', 'getBusinessCheckingListingFeatures',
      'getBusinessCheckingListingFees', 'getBusinessCheckingListingPlans', 'getBusinessCheckingListingPromotions',
      'listBusinessCheckingAccounts', 'listBusinessCheckingListings', 'searchBusinessCheckingFacts',
    ])
    for (const o of ops) {
      expect(o.summary && o.description && o.tags.length).toBeTruthy()
      expect(o.responses['200'].content['application/json'].example).toBeDefined()
      for (const s of ['400', '401', '429', '500'])
        expect(o.responses[s].content['application/problem+json'].schema.$ref).toBe('#/components/schemas/Problem')
      expect(o.description).toContain('application_url')
    }
    expect(spec.paths['/business-checking-listings/{listing_slug}'].get.responses['404']).toBeDefined()
  })

  it('list query parameters equal the v2 tool schema keys, both directions; arrays are comma-separated', () => {
    const keys = Object.keys(TOOLS_V2.find((t) => t.name === 'list_business_checking')!.inputSchema.properties).sort()
    const params = spec.paths['/business-checking-listings'].get.parameters.map((p: any) => p.name).sort()
    expect(params).toEqual(keys)
    const arr = spec.paths['/business-checking-listings'].get.parameters.find((p: any) => p.name === 'entity_types_accepted')
    expect(arr).toMatchObject({ style: 'form', explode: false })
  })
})
