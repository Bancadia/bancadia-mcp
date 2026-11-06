import { describe, it, expect, vi } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'

vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn() }))
vi.mock('../lib/analytics', () => ({ recordQueryEvent: vi.fn() }))

import app from '../index'
import { createSupabaseClient } from '../lib/supabase'
import { buildOpenApi } from '../lib/openapi'
import { TOOLS } from '../lib/tools'
import { mapBusinessCheckingRow, type BusinessCheckingQueryRow } from '../handlers/query-business-checking'
import { handleGetBusinessCheckingListing } from '../handlers/get-business-checking-listing'

const spec = buildOpenApi() as any
const props = (name: string) => Object.keys(spec.components.schemas[name].properties).sort()

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
    for (const n of ['BusinessCheckingListing', 'BusinessCheckingListingDetail', 'ListResponse', 'DetailResponse', 'Problem'])
      expect(spec.components.schemas[n]).toBeDefined()
    const ops = Object.values(spec.paths).map((p: any) => p.get)
    expect(ops.map((o: any) => o.operationId).sort()).toEqual(['getBusinessCheckingAccount', 'searchBusinessCheckingAccounts'])
    for (const o of ops) {
      expect(o.summary && o.description && o.tags.length).toBeTruthy()
      expect(o.responses['200'].content['application/json'].example).toBeDefined()
      for (const s of ['400', '401', '429', '500'])
        expect(o.responses[s].content['application/problem+json'].schema.$ref).toBe('#/components/schemas/Problem')
      expect(o.description).toContain('application_url')
    }
    expect(spec.paths['/business-checking/{listing_slug}'].get.responses['404']).toBeDefined()
  })

  it('query parameters equal the tool schema keys, both directions', () => {
    const keys = Object.keys(TOOLS.find((t) => t.name === 'query_business_checking')!.inputSchema.properties).sort()
    const params = spec.paths['/business-checking'].get.parameters.map((p: any) => p.name).sort()
    expect(params).toEqual(keys)
    const arr = spec.paths['/business-checking'].get.parameters.find((p: any) => p.name === 'entity_types_accepted')
    expect(arr).toMatchObject({ style: 'form', explode: false })
  })
})

const row = {
  id: 'l1', institution_id: 'i1', listing_slug: 'found', product_name: 'Found', monthly_fee: 0,
  monthly_fee_waiver_condition: null, minimum_opening_deposit: 0, entity_types_accepted: ['llc'],
  available_states: ['ALL'], insurance_type: 'fdic', deposit_insurance_limit: 250000, deposit_insurance_extended: false, deposit_insurance_extended_limit: null, application_url: '/go/x', last_modified: '2026-01-01', last_verified: null,
  is_verified: true, listing_status: 'active',
  institutions: { name: 'Found', display_name: 'Found', website_url: null, logo_url: null, institution_type: 'fintech', support_email: null },
  business_checking_details: { free_transactions_per_month: 1 },
  business_deposit_plan_tiers: [{ id: 't1', plan_name: 'Std', monthly_fee: 0, monthly_fee_waiver_condition: null, apy: null, apy_max_balance_eligible: null, apy_condition: null, is_default: true, sort_order: 0 }],
  business_deposit_promotions: [{ bonus_amount: 1, condition_description: 'x', minimum_deposit: null, expiry_date: null, promo_url: null }],
  business_deposit_account_target_segments: [],
  business_deposit_fees: [{ plan_tier_id: null, fee_type: 'overdraft', amount: 1, amount_description: null, eligibility_criteria: null, tiers: null, waivable: false, waiver_condition: null }],
  business_deposit_account_features: [{ plan_tier_id: null, category: 'other', description: 'd', value: null, sort_order: 0 }],
}

describe('contract: response keys equal component schema properties', () => {
  it('list row', () => {
    expect(Object.keys(mapBusinessCheckingRow(row as unknown as BusinessCheckingQueryRow)).sort()).toEqual(props('BusinessCheckingListing'))
  })
  it('detail row, including nested objects', async () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'limit']) chain[m] = vi.fn().mockReturnValue(chain)
    chain.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [row], error: null }).then(r)
    vi.mocked(createSupabaseClient).mockReturnValue({ from: () => chain } as never)
    const ctx = createExecutionContext()
    const [d] = (await handleGetBusinessCheckingListing({ listing_slug: 'found' }, env, ctx, {} as never)) as any[]
    const s = spec.components.schemas
    expect(Object.keys(d).sort()).toEqual(props('BusinessCheckingListingDetail'))
    const keys = (o: object) => Object.keys(o).sort()
    const sch = (n: string) => keys(s.BusinessCheckingListingDetail.properties[n].items.properties)
    expect(keys(d.plan_tiers[0])).toEqual(sch('plan_tiers'))
    expect(keys(d.general_fees[0])).toEqual(sch('general_fees'))
    expect(keys(d.general_features[0])).toEqual(sch('general_features'))
    const list = mapBusinessCheckingRow(row as unknown as BusinessCheckingQueryRow) as any
    expect(keys(list.institution)).toEqual(keys(s.BusinessCheckingListing.properties.institution.properties))
    expect(keys(list.promotions[0])).toEqual(keys(s.BusinessCheckingListing.properties.promotions.items.properties))
  })
})
