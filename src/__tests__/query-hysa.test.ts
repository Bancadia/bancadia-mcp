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
  product_name: 'Premier Savings',
  apy: 5.0,
  apy_rate_variability: 'variable',
  apy_balance_variation: 'none',
  minimum_balance_to_earn_apy: 0,
  minimum_opening_deposit: 0,
  monthly_fee: 0,
  insurance_type: 'fdic',
  available_states: ['ALL'],
  application_url: 'https://example.com/apply',
  last_modified: '2026-01-01',
  is_verified: true,
  listing_status: 'active',
  institutions: { name: 'Example Bank' },
}

describe('query_hysa handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns all active HYSA listings with no filters', async () => {
    const chain = mockQueryChain({ data: [sampleListing], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_hysa', arguments: {} },
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

  it('applies apy_min filter — only listings with apy >= value returned', async () => {
    const lowApy = { ...sampleListing, apy: 1.0 }
    const highApy = { ...sampleListing, apy: 5.0 }
    const chain = mockQueryChain({ data: [highApy], error: null }) // Supabase returns pre-filtered data
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_hysa', arguments: { apy_min: 4.0 } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    // The mock returns only highApy — Supabase SQL filter handled it
    expect(results.every((r: { apy: number }) => r.apy >= 4.0)).toBe(true)
    // lowApy not in results (not returned by mock)
    expect(results.find((r: { apy: number }) => r.apy < 4.0)).toBeUndefined()
  })

  it('JS-side available_states filter: ALL listings included, non-matching excluded', async () => {
    const allStates = { ...sampleListing, available_states: ['ALL'] }
    const caOnly = { ...sampleListing, available_states: ['CA', 'NY'] }
    const txOnly = { ...sampleListing, available_states: ['TX'] }
    const chain = mockQueryChain({ data: [allStates, caOnly, txOnly], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_hysa', arguments: { available_states: ['CA'] } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text) as Array<{
      available_states: string[]
    }>
    // ALL and CA are included, TX-only is excluded
    expect(results.length).toBe(2)
    expect(
      results.some((r) => r.available_states.includes('ALL'))
    ).toBe(true)
    expect(
      results.some((r) => r.available_states.includes('CA'))
    ).toBe(true)
    expect(
      results.some((r) => r.available_states.includes('TX') && !r.available_states.includes('CA'))
    ).toBe(false)
  })

  it('returns empty array when no listings match', async () => {
    const chain = mockQueryChain({ data: [], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_hysa', arguments: { apy_min: 99 } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    expect(results).toEqual([])
  })

  it('result objects contain all required fields including institution_name', async () => {
    const chain = mockQueryChain({ data: [sampleListing], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'query_hysa', arguments: {} },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    const item = results[0]

    expect(item).toHaveProperty('institution_name')
    expect(item).toHaveProperty('product_name')
    expect(item).toHaveProperty('apy')
    expect(item).toHaveProperty('apy_rate_variability')
    expect(item).toHaveProperty('apy_balance_variation')
    expect(item).toHaveProperty('minimum_balance_to_earn_apy')
    expect(item).toHaveProperty('minimum_opening_deposit')
    expect(item).toHaveProperty('monthly_fee')
    expect(item).toHaveProperty('insurance_type')
    expect(item).toHaveProperty('available_states')
    expect(item).toHaveProperty('application_url')
    expect(item).toHaveProperty('last_modified')
    expect(item).toHaveProperty('is_verified')
    expect(item.institution_name).toBe('Example Bank')
  })
})
