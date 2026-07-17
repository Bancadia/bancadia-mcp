import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'

interface QueryPersonalSavingsOptions {
  hysaOnly?: boolean
}

export async function handleQueryPersonalSavings(
  args: Record<string, unknown>,
  env: Env,
  options: QueryPersonalSavingsOptions = {}
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  const { hysaOnly = false } = options

  const productTypes = hysaOnly
    ? ['hysa']
    : args.product_type
      ? [args.product_type as string]
      : ['hysa', 'money_market']

  let query = supabase
    .from('personal_deposit_accounts')
    .select('*, personal_savings_details(*), institutions(name)')
    .eq('listing_status', 'active')
    .in('product_type', productTypes)
    .order('apy', { ascending: false, foreignTable: 'personal_savings_details' })

  if (args.apy_min !== undefined) {
    query = query.gte('personal_savings_details.apy', args.apy_min)
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
  if (args.institution_type !== undefined) {
    query = query.eq('institution_type', args.institution_type)
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

  // JS-side filter for apy_rate_variability
  if (args.apy_rate_variability !== undefined) {
    const requested = args.apy_rate_variability as string
    results = results.filter((row) => {
      const details = row.personal_savings_details as Record<string, unknown> | null
      return details?.apy_rate_variability === requested
    })
  }

  // JS-side filter for compounding_frequency
  if (args.compounding_frequency !== undefined) {
    const requested = args.compounding_frequency as string
    results = results.filter((row) => {
      const details = row.personal_savings_details as Record<string, unknown> | null
      return details?.compounding_frequency === requested
    })
  }

  return results.map((row) => {
    const institutions = row.institutions as { name?: string } | null
    const details = row.personal_savings_details as Record<string, unknown> | null
    return {
      institution_name: institutions?.name ?? null,
      product_name: row.product_name,
      product_type: row.product_type,
      apy: details?.apy ?? null,
      apy_rate_variability: details?.apy_rate_variability ?? null,
      apy_balance_variation: details?.apy_balance_variation ?? null,
      minimum_balance_to_earn_apy: details?.minimum_balance_to_earn_apy ?? null,
      minimum_opening_deposit: row.minimum_opening_deposit,
      monthly_fee: row.monthly_fee,
      insurance_type: row.insurance_type,
      institution_type: row.institution_type,
      available_states: row.available_states,
      application_url: row.application_url,
      last_modified: row.last_modified,
      is_verified: row.is_verified,
    }
  })
}
