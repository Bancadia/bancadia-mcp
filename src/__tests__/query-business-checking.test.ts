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
  const methods = ['select', 'eq', 'neq', 'gte', 'lte', 'order', 'is']
  for (const m of methods) chain[m] = vi.fn().mockReturnValue(chain)
  chain['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

const sampleListing = {
  id: 'listing-uuid-1',
  institution_id: 'institution-uuid-1',
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

  it('fire-and-forget records a query_match_events row per listing without affecting the response', async () => {
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
      params: { name: 'query_business_checking', arguments: { monthly_fee_max: 10 } },
    })
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
    const results = JSON.parse(body.result.content[0].text)
    // The client-facing shape is unaffected by analytics recording.
    expect(results[0]).not.toHaveProperty('id')
    expect(results[0]).not.toHaveProperty('institution_id')

    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({
        listing_id: 'listing-uuid-1',
        institution_id: 'institution-uuid-1',
        listing_slug: 'example-bank-business-checking-pro',
        tool_name: 'query_business_checking',
        developer_id: TEST_DEVELOPER_ID,
        session_id: TEST_SESSION_ID,
        result_rank: 1,
        result_count: 1,
        query_filters: { monthly_fee_max: 10 },
      }),
    ])
  })
})

// ---------------------------------------------------------------------------
// Regression coverage for: dot-path filters against joined `*_details` tables
// (e.g. business_checking_details.accounting_integration_available) are only
// row-restricting when the embed uses the `!inner` join hint. Without it,
// PostgREST silently ignores the filter for row exclusion, so a listing that
// fails the filter still comes back in both the response and
// query_match_events. `mockQueryChain` above can't catch this class of bug
// because it's an unconditional passthrough regardless of filter arguments.
// `mockRealisticQueryChain` below actually simulates that PostgREST
// semantics so these tests go red against the unfixed handler and green only
// once the handler conditionally adds `!inner`.
// ---------------------------------------------------------------------------

type FilterCall = { method: 'eq' | 'gte' | 'lte'; column: string; value: unknown }
type OrderSpec = { column: string; ascending: boolean; foreignTable?: string }

function mockRealisticQueryChain(fixtureRows: Array<Record<string, unknown>>) {
  const filters: FilterCall[] = []
  let selectString = ''
  let orderSpec: OrderSpec | null = null
  const chain: Record<string, unknown> = {}

  chain.select = vi.fn().mockImplementation((s: string) => {
    selectString = s
    return chain
  })
  chain.order = vi.fn().mockImplementation((column: string, opts?: { ascending?: boolean; foreignTable?: string }) => {
    orderSpec = { column, ascending: opts?.ascending !== false, foreignTable: opts?.foreignTable }
    return chain
  })
  chain.is = vi.fn().mockReturnValue(chain)
  chain.neq = vi.fn().mockReturnValue(chain)
  for (const method of ['eq', 'gte', 'lte'] as const) {
    chain[method] = vi.fn().mockImplementation((column: string, value: unknown) => {
      filters.push({ method, column, value })
      return chain
    })
  }

  const compare = (method: FilterCall['method'], actual: unknown, expected: unknown): boolean => {
    if (actual === null || actual === undefined) return false
    if (method === 'eq') return actual === expected
    if (method === 'gte') return (actual as number) >= (expected as number)
    return (actual as number) <= (expected as number)
  }

  chain.then = (resolve: (v: unknown) => unknown) => {
    const innerTables = new Set(Array.from(selectString.matchAll(/(\w+)!inner/g)).map((m) => m[1]))

    let rows = fixtureRows.filter((row) =>
      filters.every(({ method, column, value }) => {
        if (column.includes('.')) {
          const [table, field] = column.split('.')
          // Without !inner, PostgREST treats a dot-path filter as shaping the
          // embedded resource only — it never excludes the parent row.
          if (!innerTables.has(table)) return true
          const nested = row[table] as Record<string, unknown> | null | undefined
          if (!nested) return false
          return compare(method, nested[field], value)
        }
        return compare(method, row[column], value)
      })
    )

    if (orderSpec) {
      const { column, ascending, foreignTable } = orderSpec
      rows = [...rows].sort((a, b) => {
        const av = (foreignTable ? (a[foreignTable] as Record<string, unknown> | null)?.[column] : a[column]) as number
        const bv = (foreignTable ? (b[foreignTable] as Record<string, unknown> | null)?.[column] : b[column]) as number
        return ascending ? av - bv : bv - av
      })
    }

    return Promise.resolve({ data: rows, error: null }).then(resolve)
  }

  return { chain, getSelectString: () => selectString }
}

const baseListing = { ...sampleListing, product_type: 'checking' }

const matchAll = {
  ...baseListing,
  id: 'listing-match-all',
  listing_slug: 'match-all',
  insurance_type: 'fdic',
  available_states: ['IL'],
  entity_types_accepted: ['llc', 'c_corp', 's_corp'],
  monthly_fee: 0,
  business_checking_details: {
    ...baseListing.business_checking_details,
    accounting_integration_available: true,
    tax_integration_available: true,
    expense_integration_available: true,
    rtp_supported: true,
    rtp_network: 'both',
    cash_deposit_available: true,
    sub_accounts_supported: true,
    interest_bearing: true,
    apy: 2.0,
    free_transactions_per_month: 100,
  },
}

const matchAllHigherFee = {
  ...matchAll,
  id: 'listing-match-all-higher-fee',
  listing_slug: 'match-all-higher-fee',
  monthly_fee: 5,
}

const wrongAccounting = {
  ...matchAll,
  id: 'listing-wrong-accounting',
  listing_slug: 'wrong-accounting',
  business_checking_details: { ...matchAll.business_checking_details, accounting_integration_available: false },
}

const wrongTax = {
  ...matchAll,
  id: 'listing-wrong-tax',
  listing_slug: 'wrong-tax',
  business_checking_details: { ...matchAll.business_checking_details, tax_integration_available: false },
}

const wrongInsurance = {
  ...matchAll,
  id: 'listing-wrong-insurance',
  listing_slug: 'wrong-insurance',
  insurance_type: 'ncua',
}

const wrongState = {
  ...matchAll,
  id: 'listing-wrong-state',
  listing_slug: 'wrong-state',
  available_states: ['NY'],
}

const wildcardState = {
  ...matchAll,
  id: 'listing-wildcard-state',
  listing_slug: 'wildcard-state',
  available_states: ['ALL'],
}

const partialEntityTypes = {
  ...matchAll,
  id: 'listing-partial-entity-types',
  listing_slug: 'partial-entity-types',
  entity_types_accepted: ['llc'],
}

const wrongRtpNetwork = {
  ...matchAll,
  id: 'listing-wrong-rtp-network',
  listing_slug: 'wrong-rtp-network',
  business_checking_details: { ...matchAll.business_checking_details, rtp_network: 'outgoing' },
}

const belowApyMin = {
  ...matchAll,
  id: 'listing-below-apy-min',
  listing_slug: 'below-apy-min',
  business_checking_details: { ...matchAll.business_checking_details, apy: 1.0 },
}

const atApyMin = {
  ...matchAll,
  id: 'listing-at-apy-min',
  listing_slug: 'at-apy-min',
  business_checking_details: { ...matchAll.business_checking_details, apy: 1.5 },
}

const belowFreeTransactionsMin = {
  ...matchAll,
  id: 'listing-below-free-tx-min',
  listing_slug: 'below-free-tx-min',
  business_checking_details: { ...matchAll.business_checking_details, free_transactions_per_month: 10 },
}

const atFreeTransactionsMin = {
  ...matchAll,
  id: 'listing-at-free-tx-min',
  listing_slug: 'at-free-tx-min',
  business_checking_details: { ...matchAll.business_checking_details, free_transactions_per_month: 25 },
}

const noDetails = {
  ...matchAll,
  id: 'listing-no-details',
  listing_slug: 'no-details',
  business_checking_details: null,
}

function setSupabaseChain(chain: unknown) {
  vi.mocked(createSupabaseClient).mockReturnValue({
    from: vi.fn().mockReturnValue(chain),
  } as unknown as ReturnType<typeof createSupabaseClient>)
}

async function runQuery(args: Record<string, unknown>) {
  const request = post({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'query_business_checking', arguments: args },
  })
  const ctx = createExecutionContext()
  const response = await app.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
  return JSON.parse(body.result.content[0].text) as Array<{ listing_slug: string }>
}

describe('advanced filter combinations — details-table restriction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedis()
  })

  it('reported-bug repro: excludes a listing whose accounting_integration_available is false even though every other filter matches', async () => {
    const { chain } = mockRealisticQueryChain([
      matchAll,
      wrongAccounting,
      wrongState,
      wrongInsurance,
      partialEntityTypes,
    ])
    setSupabaseChain(chain)

    const results = await runQuery({
      insurance_type: 'fdic',
      available_states: ['IL'],
      entity_types_accepted: ['llc', 'c_corp'],
      accounting_integration_available: true,
    })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it.each([
    ['accounting_integration_available', true],
    ['tax_integration_available', true],
    ['expense_integration_available', true],
    ['rtp_supported', true],
    ['cash_deposit_available', true],
    ['sub_accounts_supported', true],
    ['interest_bearing', true],
  ] as const)('excludes listings where %s does not match the requested value', async (key, value) => {
    const wrongVariant = {
      ...matchAll,
      id: `listing-wrong-${key}`,
      listing_slug: `wrong-${key}`,
      business_checking_details: { ...matchAll.business_checking_details, [key]: !value },
    }
    const { chain } = mockRealisticQueryChain([matchAll, wrongVariant])
    setSupabaseChain(chain)

    const results = await runQuery({ [key]: value })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it('excludes listings where rtp_network does not match the requested value', async () => {
    const { chain } = mockRealisticQueryChain([matchAll, wrongRtpNetwork])
    setSupabaseChain(chain)

    const results = await runQuery({ rtp_network: 'both' })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it('combines multiple details-table filters with AND semantics, not OR', async () => {
    const { chain } = mockRealisticQueryChain([matchAll, wrongTax])
    setSupabaseChain(chain)

    const results = await runQuery({
      accounting_integration_available: true,
      tax_integration_available: true,
    })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it('excludes a row satisfying only ONE of two requested boolean details filters (rtp_supported true, accounting_integration_available false)', async () => {
    const rtpButNotAccounting = {
      ...matchAll,
      id: 'listing-rtp-not-accounting',
      listing_slug: 'rtp-not-accounting',
      business_checking_details: {
        ...matchAll.business_checking_details,
        rtp_supported: true,
        accounting_integration_available: false,
      },
    }
    const { chain } = mockRealisticQueryChain([matchAll, rtpButNotAccounting])
    setSupabaseChain(chain)

    const results = await runQuery({
      rtp_supported: true,
      accounting_integration_available: true,
    })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it('excludes a row satisfying only the OTHER of two requested boolean details filters (accounting_integration_available true, rtp_supported false)', async () => {
    const accountingButNotRtp = {
      ...matchAll,
      id: 'listing-accounting-not-rtp',
      listing_slug: 'accounting-not-rtp',
      business_checking_details: {
        ...matchAll.business_checking_details,
        accounting_integration_available: true,
        rtp_supported: false,
      },
    }
    const { chain } = mockRealisticQueryChain([matchAll, accountingButNotRtp])
    setSupabaseChain(chain)

    const results = await runQuery({
      rtp_supported: true,
      accounting_integration_available: true,
    })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it('requires ALL of three combined details filters (boolean + enum + numeric) to match — AND across every filter, not just pairs', async () => {
    const missingOne = {
      ...matchAll,
      id: 'listing-missing-one-of-three',
      listing_slug: 'missing-one-of-three',
      business_checking_details: {
        ...matchAll.business_checking_details,
        rtp_supported: true,
        rtp_network: 'both',
        accounting_integration_available: true,
        apy: 1.0, // below the apy_min threshold requested below
      },
    }
    const { chain } = mockRealisticQueryChain([matchAll, missingOne])
    setSupabaseChain(chain)

    const results = await runQuery({
      rtp_supported: true,
      accounting_integration_available: true,
      apy_min: 1.5,
    })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it('apy_min is an inclusive lower bound (gte) on the joined apy column', async () => {
    const { chain } = mockRealisticQueryChain([belowApyMin, atApyMin])
    setSupabaseChain(chain)

    const results = await runQuery({ apy_min: 1.5 })

    expect(results.map((r) => r.listing_slug)).toEqual(['at-apy-min'])
  })

  it('free_transactions_min is an inclusive lower bound (gte) on the joined column', async () => {
    const { chain } = mockRealisticQueryChain([belowFreeTransactionsMin, atFreeTransactionsMin])
    setSupabaseChain(chain)

    const results = await runQuery({ free_transactions_min: 25 })

    expect(results.map((r) => r.listing_slug)).toEqual(['at-free-tx-min'])
  })

  it('includes a listing with no details row when no details-filter is requested', async () => {
    const { chain } = mockRealisticQueryChain([matchAll, noDetails])
    setSupabaseChain(chain)

    const results = await runQuery({})

    expect(results.map((r) => r.listing_slug).sort()).toEqual(['match-all', 'no-details'])
  })

  it('excludes a listing with no details row once a details-filter is requested', async () => {
    const { chain } = mockRealisticQueryChain([matchAll, noDetails])
    setSupabaseChain(chain)

    const results = await runQuery({ accounting_integration_available: true })

    expect(results.map((r) => r.listing_slug)).toEqual(['match-all'])
  })

  it('adds the !inner join hint to business_checking_details only when a details-table filter is present', async () => {
    const filtered = mockRealisticQueryChain([matchAll])
    setSupabaseChain(filtered.chain)
    await runQuery({ accounting_integration_available: true })
    expect(filtered.getSelectString()).toMatch(/business_checking_details!inner/)

    const unfiltered = mockRealisticQueryChain([matchAll])
    setSupabaseChain(unfiltered.chain)
    await runQuery({})
    expect(unfiltered.getSelectString()).not.toMatch(/business_checking_details!inner/)
    expect(unfiltered.getSelectString()).toMatch(/business_checking_details\(/)
  })

  it('query_match_events mirrors the filtered response exactly — same listings, correct rank/count, no leaked non-matches', async () => {
    const { chain } = mockRealisticQueryChain([matchAllHigherFee, matchAll, wrongAccounting])
    const insertMock = vi.fn().mockResolvedValue({ data: null, error: null })
    const from = vi.fn().mockImplementation((table: string) => (table === 'query_match_events' ? { insert: insertMock } : chain))
    vi.mocked(createSupabaseClient).mockReturnValue({ from } as unknown as ReturnType<typeof createSupabaseClient>)

    const results = await runQuery({ accounting_integration_available: true })

    // monthly_fee ASC: matchAll (0) before matchAllHigherFee (5); wrongAccounting/wrongState excluded.
    expect(results.map((r) => r.listing_slug)).toEqual(['match-all', 'match-all-higher-fee'])

    expect(insertMock).toHaveBeenCalledTimes(1)
    const insertedRows = insertMock.mock.calls[0][0] as Array<{
      listing_id: string
      result_rank: number
      result_count: number
    }>
    expect(insertedRows).toHaveLength(2)
    expect(insertedRows.map((r) => r.listing_id)).toEqual([matchAll.id, matchAllHigherFee.id])
    expect(insertedRows.map((r) => r.result_rank)).toEqual([1, 2])
    expect(insertedRows.every((r) => r.result_count === 2)).toBe(true)
  })
})
