import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'

export async function handleQueryPersonalChecking(
  args: Record<string, unknown>,
  env: Env
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  let query = supabase
    .from('personal_deposit_accounts')
    .select('*, personal_checking_details(*), institutions(name)')
    .eq('listing_status', 'active')
    .eq('product_type', 'checking')
    .order('monthly_fee', { ascending: true })

  if (args.monthly_fee_max !== undefined) {
    query = query.lte('monthly_fee', args.monthly_fee_max)
  }
  if (args.minimum_opening_deposit_max !== undefined) {
    query = query.lte('minimum_opening_deposit', args.minimum_opening_deposit_max)
  }
  if (args.insurance_type !== undefined) {
    query = query.eq('insurance_type', args.insurance_type)
  }

  const { data, error } = await query

  if (error || !data) {
    return []
  }

  let results = data as Record<string, unknown>[]

  // JS-side filter for available_states
  if (Array.isArray(args.available_states) && args.available_states.length > 0) {
    const requestedStates = args.available_states as string[]
    results = results.filter((row) => {
      const rowStates = row.available_states as string[] | null
      if (!rowStates) return false
      if (rowStates.includes('ALL')) return true
      return requestedStates.every((s) => rowStates.includes(s))
    })
  }

  // JS-side filter for overdraft_protection_available
  if (args.overdraft_protection_available !== undefined) {
    const requested = args.overdraft_protection_available as boolean
    results = results.filter((row) => {
      const details = row.personal_checking_details as Record<string, unknown> | null
      return details?.overdraft_protection_available === requested
    })
  }

  // JS-side filter for atm_fee_reimbursement
  if (args.atm_fee_reimbursement !== undefined) {
    const requested = args.atm_fee_reimbursement as boolean
    results = results.filter((row) => {
      const details = row.personal_checking_details as Record<string, unknown> | null
      return details?.atm_fee_reimbursement === requested
    })
  }

  // JS-side filter for interest_bearing
  if (args.interest_bearing !== undefined) {
    const requested = args.interest_bearing as boolean
    results = results.filter((row) => {
      const details = row.personal_checking_details as Record<string, unknown> | null
      return details?.interest_bearing === requested
    })
  }

  return results.map((row) => {
    const institutions = row.institutions as { name?: string } | null
    const details = row.personal_checking_details as Record<string, unknown> | null
    return {
      institution_name: institutions?.name ?? null,
      product_name: row.product_name,
      monthly_fee: row.monthly_fee,
      monthly_fee_waiver_condition: row.monthly_fee_waiver_condition,
      minimum_opening_deposit: row.minimum_opening_deposit,
      insurance_type: row.insurance_type,
      available_states: row.available_states,
      overdraft_protection_available: details?.overdraft_protection_available ?? null,
      check_writing_available: details?.check_writing_available ?? null,
      atm_fee_reimbursement: details?.atm_fee_reimbursement ?? null,
      interest_bearing: details?.interest_bearing ?? null,
      apy: details?.interest_bearing ? (details?.apy ?? null) : null,
      application_url: row.application_url,
      last_modified: row.last_modified,
      is_verified: row.is_verified,
    }
  })
}
