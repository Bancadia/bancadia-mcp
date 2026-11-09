import { describe, it, expect } from 'vitest'

// Dynamic imports so each test fails individually while the modules do not exist yet.
describe('normalizeArgs (case-insensitive enums)', () => {
  it('lower-cases enum-like args and upper-cases states', async () => {
    const { normalizeArgs } = await import('../lib/normalize-args')
    const out = normalizeArgs('list_business_checking', {
      insurance_type: ' FDIC ', rtp_network: 'Both', sort: 'Apy_Max_Desc',
      entity_types_accepted: ['LLC', 'Sole_Prop'], available_states: ['ny', 'Tx', 'all'],
      integrations_any: ['QBO'], integrations_all: ['Xero'], rank_industries: ['Ecommerce'], rank_profiles: ['VC_Backed'],
      fields: ['APY_Max'], min_limits: { SUB_ACCOUNTS: 3 },
    })
    expect(out).toEqual({
      insurance_type: 'fdic', rtp_network: 'both', sort: 'apy_max_desc',
      entity_types_accepted: ['llc', 'sole_prop'], available_states: ['NY', 'TX', 'ALL'],
      integrations_any: ['qbo'], integrations_all: ['xero'], rank_industries: ['ecommerce'], rank_profiles: ['vc_backed'],
      fields: ['apy_max'], min_limits: { sub_accounts: 3 },
    })
  })

  it('normalizes the other tools: topic, fee_types, sections, slugs; leaves query, plan case, numbers and booleans alone', async () => {
    const { normalizeArgs } = await import('../lib/normalize-args')
    expect(normalizeArgs('search_facts', { query: 'Zelle -FEE', topic: 'FEES', slugs: ['A-Bank'], per_bank: 2 }))
      .toEqual({ query: 'Zelle -FEE', topic: 'fees', slugs: ['a-bank'], per_bank: 2 })
    expect(normalizeArgs('fees_by_type', { fee_types: ['Cash_Deposit'], slugs: ['X'], plan: ' Grow ' }))
      .toEqual({ fee_types: ['cash_deposit'], slugs: ['x'], plan: 'Grow' })
    expect(normalizeArgs('get_listing', { slugs: ['A'], sections: ['FEES', 'Tiers'] })).toEqual({ slugs: ['a'], sections: ['fees', 'tiers'] })
    expect(normalizeArgs('list_business_checking', { monthly_fee_max: 0, interest_bearing: false, limit: 5 }))
      .toEqual({ monthly_fee_max: 0, interest_bearing: false, limit: 5 })
  })

  it('does not mutate its input', async () => {
    const { normalizeArgs } = await import('../lib/normalize-args')
    const input = { insurance_type: 'FDIC', entity_types_accepted: ['LLC'] }
    normalizeArgs('list_business_checking', input)
    expect(input).toEqual({ insurance_type: 'FDIC', entity_types_accepted: ['LLC'] })
  })
})

describe('mapDbError (DB error to tool error)', () => {
  it('SQLSTATE 22023 becomes invalid_args carrying the DB message verbatim', async () => {
    const { mapDbError } = await import('../lib/db-errors')
    const message = 'Unknown insurance type: bogus. Valid insurance types: fdic, ncua, uninsured'
    expect(mapDbError({ message, code: '22023' })).toEqual({ kind: 'invalid_args', message })
  })

  it.each([['XX000'], ['42P01'], ['PGRST301'], [undefined]])('code %s becomes a generic error with no message', async (code) => {
    const { mapDbError } = await import('../lib/db-errors')
    const r = mapDbError({ message: 'relation "secret_table" does not exist', code })
    expect(r).toEqual({ kind: 'error' })
  })
})
