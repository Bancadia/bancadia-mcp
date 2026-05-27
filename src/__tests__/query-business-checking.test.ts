import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(function () {
    return {
      get: vi.fn().mockResolvedValue(true), // always authenticated (cache hit)
      set: vi.fn().mockResolvedValue('OK'),
    }
  }),
}))

vi.mock('../lib/supabase', () => ({
  createSupabaseClient: vi.fn(),
}))

import app from '../index'
import { createSupabaseClient } from '../lib/supabase'

function post(body: object) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk_test_token',
    },
    body: JSON.stringify(body),
  })
}

function mockQueryChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'is']
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain)
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

const sampleListing = {
  product_name: 'Business Checking Pro',
  monthly_fee: 0,
  monthly_fee_waiver_condition: null,
  free_transactions_per_month: 100,
  entity_types_accepted: ['llc', 'sole_proprietor', 'corporation'],
  integrations: ['quickbooks', 'stripe'],
  cash_deposit_available: true,
  sub_accounts_supported: true,
  rtp_enabled: true,
  outgoing_domestic_wire_fee: 15,
  application_url: 'https://example.com/apply',
  last_modified: '2026-01-01',
  is_verified: true,
  listing_status: 'active',
  institutions: { name: 'Example Bank' },
}

describe('query_business_checking handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all active BC listings with no filters ordered by monthly_fee ASC', async () => {
    const chain = mockQueryChain({ data: [sampleListing], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_business_checking', arguments: {} },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(1)
  })

  it('JS-side entity_types_accepted filter: only listings containing all requested types', async () => {
    const fullTypes = {
      ...sampleListing,
      entity_types_accepted: ['llc', 'sole_proprietor', 'corporation'],
    }
    const partialTypes = { ...sampleListing, entity_types_accepted: ['llc'] }
    const chain = mockQueryChain({ data: [fullTypes, partialTypes], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'query_business_checking',
        arguments: { entity_types_accepted: ['llc', 'sole_proprietor'] },
      },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text) as Array<{
      entity_types_accepted: string[]
    }>
    // Only fullTypes matches both llc and sole_proprietor
    expect(results.length).toBe(1)
    expect(results[0].entity_types_accepted).toContain('llc')
    expect(results[0].entity_types_accepted).toContain('sole_proprietor')
  })

  it('JS-side integrations filter: only listings with all requested integrations', async () => {
    const bothIntegrations = { ...sampleListing, integrations: ['quickbooks', 'stripe', 'xero'] }
    const onlyQuickbooks = { ...sampleListing, integrations: ['quickbooks'] }
    const noIntegrations = { ...sampleListing, integrations: null }
    const chain = mockQueryChain({
      data: [bothIntegrations, onlyQuickbooks, noIntegrations],
      error: null,
    })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'query_business_checking',
        arguments: { integrations: ['quickbooks', 'stripe'] },
      },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text) as Array<{
      integrations: string[] | null
    }>
    // Only bothIntegrations has both quickbooks and stripe
    expect(results.length).toBe(1)
    expect(results[0].integrations).toContain('quickbooks')
    expect(results[0].integrations).toContain('stripe')
  })

  it('result objects contain all required fields', async () => {
    const chain = mockQueryChain({ data: [sampleListing], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_business_checking', arguments: {} },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    const item = results[0]

    expect(item).toHaveProperty('institution_name')
    expect(item).toHaveProperty('product_name')
    expect(item).toHaveProperty('monthly_fee')
    expect(item).toHaveProperty('monthly_fee_waiver_condition')
    expect(item).toHaveProperty('free_transactions_per_month')
    expect(item).toHaveProperty('entity_types_accepted')
    expect(item).toHaveProperty('integrations')
    expect(item).toHaveProperty('cash_deposit_available')
    expect(item).toHaveProperty('sub_accounts_supported')
    expect(item).toHaveProperty('outgoing_domestic_wire_fee')
    expect(item).toHaveProperty('application_url')
    expect(item).toHaveProperty('last_modified')
    expect(item).toHaveProperty('is_verified')
    expect(item.institution_name).toBe('Example Bank')
  })
})
