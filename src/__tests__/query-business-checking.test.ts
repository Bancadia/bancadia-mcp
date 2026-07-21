import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return {
      limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }),
    }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

vi.mock('../lib/supabase', () => ({
  createSupabaseClient: vi.fn(),
}))

import app from '../index'
import { createSupabaseClient } from '../lib/supabase'
import { mockRedis, withSession } from './helpers'

function post(body: object) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk_test_token',
      ...withSession(),
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
  listing_slug: 'example-bank-business-checking-pro',
  product_name: 'Business Checking Pro',
  monthly_fee: 0,
  monthly_fee_waiver_condition: null,
  minimum_opening_deposit: 0,
  entity_types_accepted: ['llc', 'sole_prop', 's_corp'],
  available_states: ['ALL'],
  insurance_type: 'fdic',
  application_url: 'https://example.com/apply',
  last_modified: '2026-01-01',
  is_verified: true,
  listing_status: 'active',
  institutions: {
    name: 'Example Bank',
    display_name: 'Example Bank',
    website_url: 'https://examplebank.com',
    logo_url: 'https://examplebank.com/logo.png',
    institution_type: 'regional_bank',
    support_email: 'support@examplebank.com',
  },
  business_checking_details: {
    free_transactions_per_month: 100,
    cash_deposit_available: true,
    cash_deposit_fee_per_100: 2.5,
    monthly_cash_deposit_limit: 5000,
    sub_accounts_supported: true,
    rtp_supported: true,
    rtp_network: 'both',
    accounting_integration_available: true,
    tax_integration_available: false,
    expense_integration_available: true,
    interest_bearing: true,
    apy: 1.25,
    apy_tiers: null,
    outgoing_domestic_wire_fee: 15,
    incoming_domestic_wire_fee: 0,
    outgoing_international_wire_fee: 45,
    incoming_international_wire_fee: 15,
    multicurrency_support: false,
    free_domestic_wires_per_month: 2,
    per_transaction_fee_after_limit: 0.5,
    atm_fee_reimbursement: true,
    atm_fee_reimbursement_limit: 10,
    atm_network: 'Allpoint',
    overdraft_protection_available: true,
    overdraft_line_of_credit_available: false,
    daily_debit_limit: 5000,
    ach_debit_block_available: true,
    positive_pay_available: true,
    remote_deposit_capture: true,
    bill_pay_available: true,
    check_writing_available: true,
    corporate_card_available: true,
    virtual_cards_available: true,
    physical_debit_card_available: true,
  },
  business_deposit_plan_tiers: [
    {
      plan_name: 'Standard',
      monthly_fee: 0,
      monthly_fee_waiver_condition: null,
      apy: 1.25,
      apy_max_balance_eligible: null,
      apy_condition: null,
      is_default: true,
      sort_order: 0,
    },
  ],
  business_deposit_promotions: [
    {
      bonus_amount: 300,
      condition_description: 'Deposit $2,500 within 30 days',
      minimum_deposit: 2500,
      expiry_date: null,
      promo_url: 'https://example.com/promo',
    },
  ],
}

describe('query_business_checking handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis()
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
      entity_types_accepted: ['llc', 'sole_prop', 's_corp'],
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
        arguments: { entity_types_accepted: ['llc', 'sole_prop'] },
      },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text) as Array<{
      entity_types_accepted: string[]
    }>
    // Only fullTypes matches both llc and sole_prop
    expect(results.length).toBe(1)
    expect(results[0].entity_types_accepted).toContain('llc')
    expect(results[0].entity_types_accepted).toContain('sole_prop')
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
      params: {
        name: 'query_business_checking',
        arguments: { available_states: ['CA'] },
      },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text) as Array<{
      available_states: string[]
    }>
    expect(results.length).toBe(2)
    expect(results.some((r) => r.available_states.includes('ALL'))).toBe(true)
    expect(results.some((r) => r.available_states.includes('CA'))).toBe(true)
    expect(
      results.some((r) => r.available_states.includes('TX') && !r.available_states.includes('CA'))
    ).toBe(false)
  })

  it('accounting_integration_available server-side filter is passed through in output', async () => {
    const chain = mockQueryChain({ data: [sampleListing], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'query_business_checking',
        arguments: { accounting_integration_available: true },
      },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text) as Array<{
      accounting_integration_available: boolean
    }>
    expect(results.length).toBe(1)
    expect(results[0].accounting_integration_available).toBe(true)
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

    expect(item).toHaveProperty('listing_slug')
    expect(item).toHaveProperty('institution_name')
    expect(item).toHaveProperty('institution')
    expect(item).toHaveProperty('product_name')
    expect(item).toHaveProperty('monthly_fee')
    expect(item).toHaveProperty('monthly_fee_waiver_condition')
    expect(item).toHaveProperty('minimum_opening_deposit')
    expect(item).toHaveProperty('entity_types_accepted')
    expect(item).toHaveProperty('available_states')
    expect(item).toHaveProperty('insurance_type')
    expect(item).toHaveProperty('free_transactions_per_month')
    expect(item).toHaveProperty('cash_deposit_available')
    expect(item).toHaveProperty('cash_deposit_fee_per_100')
    expect(item).toHaveProperty('monthly_cash_deposit_limit')
    expect(item).toHaveProperty('sub_accounts_supported')
    expect(item).toHaveProperty('rtp_supported')
    expect(item).toHaveProperty('rtp_network')
    expect(item).toHaveProperty('accounting_integration_available')
    expect(item).toHaveProperty('tax_integration_available')
    expect(item).toHaveProperty('expense_integration_available')
    expect(item).toHaveProperty('interest_bearing')
    expect(item).toHaveProperty('apy')
    expect(item).toHaveProperty('apy_tiers')
    expect(item).toHaveProperty('outgoing_domestic_wire_fee')
    expect(item).toHaveProperty('incoming_domestic_wire_fee')
    expect(item).toHaveProperty('outgoing_international_wire_fee')
    expect(item).toHaveProperty('incoming_international_wire_fee')
    expect(item).toHaveProperty('multicurrency_support')
    expect(item).toHaveProperty('free_domestic_wires_per_month')
    expect(item).toHaveProperty('per_transaction_fee_after_limit')
    expect(item).toHaveProperty('atm_fee_reimbursement')
    expect(item).toHaveProperty('atm_fee_reimbursement_limit')
    expect(item).toHaveProperty('atm_network')
    expect(item).toHaveProperty('overdraft_protection_available')
    expect(item).toHaveProperty('overdraft_line_of_credit_available')
    expect(item).toHaveProperty('daily_debit_limit')
    expect(item).toHaveProperty('ach_debit_block_available')
    expect(item).toHaveProperty('positive_pay_available')
    expect(item).toHaveProperty('remote_deposit_capture')
    expect(item).toHaveProperty('bill_pay_available')
    expect(item).toHaveProperty('check_writing_available')
    expect(item).toHaveProperty('corporate_card_available')
    expect(item).toHaveProperty('virtual_cards_available')
    expect(item).toHaveProperty('physical_debit_card_available')
    expect(item).toHaveProperty('plan_tiers')
    expect(item).toHaveProperty('promotions')
    expect(item).toHaveProperty('application_url')
    expect(item).toHaveProperty('last_modified')
    expect(item).toHaveProperty('is_verified')
    expect(item.institution_name).toBe('Example Bank')
    expect(item.institution.institution_type).toBe('regional_bank')
    expect(item.incoming_international_wire_fee).toBe(15)
    expect(item.multicurrency_support).toBe(false)
    expect(item.plan_tiers[0].plan_name).toBe('Standard')
    expect(item.promotions[0].bonus_amount).toBe(300)
  })
})
