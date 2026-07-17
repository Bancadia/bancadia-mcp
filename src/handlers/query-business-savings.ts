import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'

export async function handleQueryBusinessSavings(
  args: Record<string, unknown>,
  env: Env
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  const productTypes = args.product_type
    ? [args.product_type as string]
    : ['hysa', 'money_market']

  let query = supabase
    .from('business_deposit_accounts')
    .select('*, business_savings_details(*), institutions(name)')
    .eq('listing_status', 'active')
    .in('product_type', productTypes)
    .order('apy', { ascending: false, foreignTable: 'business_savings_details' })

  if (args.apy_min !== undefined) {
    query = query.gte('business_savings_details.apy', args.apy_min)
  }
  if (args.insurance_type !== undefined) {
    query = query.eq('insurance_type', args.insurance_type)
  }
  if (args.minimum_opening_deposit_max !== undefined) {
    query = query.lte('minimum_opening_deposit', args.minimum_opening_deposit_max)
  }
  if (args.monthly_fee_max !== undefined) {
    query = query.lte('monthly_fee', args.monthly_fee_max)
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

  // JS-side filter for entity_types_accepted
  if (Array.isArray(args.entity_types_accepted) && args.entity_types_accepted.length > 0) {
    const requestedTypes = args.entity_types_accepted as string[]
    results = results.filter((row) => {
      const rowTypes = row.entity_types_accepted as string[] | null
      if (!rowTypes) return false
      return requestedTypes.every((t) => rowTypes.includes(t))
    })
  }

  return results.map((row) => {
    const institutions = row.institutions as { name?: string } | null
    const details = row.business_savings_details as Record<string, unknown> | null
    return {
      institution_name: institutions?.name ?? null,
      product_name: row.product_name,
      product_type: row.product_type,
      apy: details?.apy ?? null,
      apy_rate_variability: details?.apy_rate_variability ?? null,
      minimum_balance_to_earn_apy: details?.minimum_balance_to_earn_apy ?? null,
      minimum_opening_deposit: row.minimum_opening_deposit,
      monthly_fee: row.monthly_fee,
      insurance_type: row.insurance_type,
      entity_types_accepted: row.entity_types_accepted,
      available_states: row.available_states,
      application_url: row.application_url,
      last_modified: row.last_modified,
      is_verified: row.is_verified,
    }
  })
}
