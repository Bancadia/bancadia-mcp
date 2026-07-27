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
import { mockRedis, withSession, TEST_SESSION_ID, TEST_DEVELOPER_ID } from './helpers'

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
  const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'is', 'limit']
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain)
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

const sampleListing = {
  id: 'listing-uuid-2',
  institution_id: 'institution-uuid-2',
  listing_slug: 'found-business-checking',
  product_name: 'Found Business Checking',
  monthly_fee: 0,
  monthly_fee_waiver_condition: null,
  minimum_opening_deposit: 0,
  entity_types_accepted: ['llc', 'sole_prop'],
  available_states: ['ALL'],
  insurance_type: 'fdic',
  application_url: 'https://example.com/apply',
  last_modified: '2026-01-01',
  is_verified: true,
  listing_status: 'active',
  institutions: {
    name: 'Found',
    display_name: 'Found',
    website_url: 'https://found.com',
    logo_url: 'https://found.com/logo.png',
    institution_type: 'fintech',
    support_email: 'support@found.com',
  },
  business_checking_details: {
    free_transactions_per_month: 100,
    cash_deposit_available: false,
    cash_deposit_fee_per_100: null,
    monthly_cash_deposit_limit: null,
    sub_accounts_supported: false,
    rtp_supported: false,
    rtp_network: 'none',
    accounting_integration_available: true,
    tax_integration_available: true,
    expense_integration_available: false,
    interest_bearing: false,
    apy: null,
    apy_tiers: null,
    outgoing_domestic_wire_fee: 20,
    incoming_domestic_wire_fee: 0,
    outgoing_international_wire_fee: null,
    incoming_international_wire_fee: null,
    multicurrency_support: false,
    free_domestic_wires_per_month: 0,
    per_transaction_fee_after_limit: null,
    atm_fee_reimbursement: false,
    atm_fee_reimbursement_limit: null,
    atm_network: null,
    overdraft_protection_available: false,
    overdraft_line_of_credit_available: false,
    daily_debit_limit: null,
    ach_debit_block_available: false,
    positive_pay_available: false,
    remote_deposit_capture: false,
    bill_pay_available: false,
    check_writing_available: false,
    corporate_card_available: false,
    virtual_cards_available: false,
    physical_debit_card_available: true,
  },
  business_deposit_plan_tiers: [
    {
      id: 'tier-standard',
      plan_name: 'Standard',
      monthly_fee: 0,
      monthly_fee_waiver_condition: null,
      apy: 0.013,
      apy_max_balance_eligible: 250000,
      apy_condition: null,
      is_default: true,
      sort_order: 0,
    },
    {
      id: 'tier-premier',
      plan_name: 'Premier',
      monthly_fee: 95,
      monthly_fee_waiver_condition: 'Waived with $100,000 average daily balance',
      apy: 0.03,
      apy_max_balance_eligible: null,
      apy_condition: null,
      is_default: false,
      sort_order: 1,
    },
  ],
  business_deposit_promotions: [
    {
      bonus_amount: 300,
      condition_description: 'Receive $2,500+ in deposits within 90 days of account opening',
      minimum_deposit: 2500,
      expiry_date: null,
      promo_url: 'https://found.com/promo',
    },
  ],
  business_deposit_fees: [
    {
      fee_type: 'overdraft',
      amount: 35,
      amount_description: null,
      eligibility_criteria: null,
      tiers: null,
      waivable: false,
      waiver_condition: null,
      plan_tier_id: null,
    },
    {
      fee_type: 'wire_domestic_outgoing',
      amount: 20,
      amount_description: null,
      eligibility_criteria: null,
      tiers: null,
      waivable: true,
      waiver_condition: 'Waived with Pro plan',
      plan_tier_id: null,
    },
    {
      fee_type: 'excess_transaction',
      amount: 25,
      amount_description: null,
      eligibility_criteria: null,
      tiers: null,
      waivable: true,
      waiver_condition: null,
      plan_tier_id: 'tier-premier',
    },
  ],
  business_deposit_account_features: [
    {
      category: 'fraud_protection',
      description: 'Instant card freeze',
      value: null,
      sort_order: 2,
      plan_tier_id: null,
    },
    {
      category: 'cash_handling',
      description: 'Free cash deposits up to $2,000/mo',
      value: 2000,
      sort_order: 1,
      plan_tier_id: null,
    },
    {
      category: 'account_management',
      description: 'Maximum number of sub-accounts included with this plan.',
      value: 3,
      sort_order: 3,
      plan_tier_id: 'tier-standard',
    },
    {
      category: 'account_management',
      description: 'Maximum number of sub-accounts included with this plan.',
      value: 10,
      sort_order: 3,
      plan_tier_id: 'tier-premier',
    },
  ],
}

describe('get_business_checking_listing handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis()
  })

  it('returns the matching listing with general fees/features, tier-scoped fees/features, and promotions', async () => {
    const chain = mockQueryChain({ data: [sampleListing], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_business_checking_listing', arguments: { listing_slug: 'found-business-checking' } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    expect(results.length).toBe(1)

    const item = results[0]
    expect(item.listing_slug).toBe('found-business-checking')
    expect(item.institution_name).toBe('Found')

    // wire_domestic_outgoing is covered by the flat outgoing_domestic_wire_fee
    // column and must not also appear in general_fees (Decision 3).
    expect(item.general_fees).toHaveLength(1)
    expect(item.general_fees[0].fee_type).toBe('overdraft')
    expect(item.general_fees[0].amount).toBe(35)
    expect(item.general_fees.some((f: { fee_type: string }) => f.fee_type === 'wire_domestic_outgoing')).toBe(false)

    // sorted by sort_order, tier-scoped features excluded
    expect(item.general_features).toHaveLength(2)
    expect(item.general_features[0].description).toBe('Free cash deposits up to $2,000/mo')
    expect(item.general_features[1].description).toBe('Instant card freeze')

    // plan tiers, in sort order, each carrying only its own fees/features
    expect(item.plan_tiers).toHaveLength(2)
    expect(item.plan_tiers[0].plan_name).toBe('Standard')
    expect(item.plan_tiers[0].id).toBeUndefined()
    expect(item.plan_tiers[0].features).toEqual([
      { category: 'account_management', description: 'Maximum number of sub-accounts included with this plan.', value: 3 },
    ])
    expect(item.plan_tiers[0].fees).toEqual([])

    expect(item.plan_tiers[1].plan_name).toBe('Premier')
    expect(item.plan_tiers[1].features).toEqual([
      { category: 'account_management', description: 'Maximum number of sub-accounts included with this plan.', value: 10 },
    ])
    expect(item.plan_tiers[1].fees).toHaveLength(1)
    expect(item.plan_tiers[1].fees[0].fee_type).toBe('excess_transaction')
    expect(item.plan_tiers[1].fees[0].amount).toBe(25)

    // promotions returned and mapped
    expect(item.promotions).toHaveLength(1)
    expect(item.promotions[0].bonus_amount).toBe(300)
    expect(item.promotions[0].condition_description).toBe(
      'Receive $2,500+ in deposits within 90 days of account opening'
    )
  })

  it('returns an empty array when no listing matches the slug', async () => {
    const chain = mockQueryChain({ data: [], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_business_checking_listing', arguments: { listing_slug: 'does-not-exist' } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    expect(results).toEqual([])
  })

  it('returns an empty array when listing_slug is missing', async () => {
    const chain = mockQueryChain({ data: [sampleListing], error: null })
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue(chain),
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_business_checking_listing', arguments: {} },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    expect(results).toEqual([])
  })

  it('fire-and-forget records a single query_match_events row for a detail lookup', async () => {
    const queryChain = mockQueryChain({ data: [sampleListing], error: null })
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null })
    const from = vi.fn().mockImplementation((table: string) =>
      table === 'query_match_events' ? { insert: insertMock } : queryChain
    )
    vi.mocked(createSupabaseClient).mockReturnValue({
      from,
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_business_checking_listing', arguments: { listing_slug: 'found-business-checking' } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    expect(results[0]).not.toHaveProperty('id')
    expect(results[0]).not.toHaveProperty('institution_id')

    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({
        listing_id: 'listing-uuid-2',
        institution_id: 'institution-uuid-2',
        listing_slug: 'found-business-checking',
        tool_name: 'get_business_checking_listing',
        developer_id: TEST_DEVELOPER_ID,
        session_id: TEST_SESSION_ID,
        result_rank: 1,
        result_count: 1,
        query_filters: { listing_slug: 'found-business-checking' },
      }),
    ])
  })

  it('does not attempt an insert when no listing matches (matchEvents empty)', async () => {
    const queryChain = mockQueryChain({ data: [], error: null })
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null })
    const from = vi.fn().mockImplementation((table: string) =>
      table === 'query_match_events' ? { insert: insertMock } : queryChain
    )
    vi.mocked(createSupabaseClient).mockReturnValue({
      from,
    } as unknown as ReturnType<typeof createSupabaseClient>)

    const request = post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_business_checking_listing', arguments: { listing_slug: 'does-not-exist' } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(insertMock).not.toHaveBeenCalled()
  })
})
