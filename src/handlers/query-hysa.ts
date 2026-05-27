import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'

export async function handleQueryHysa(
  args: Record<string, unknown>,
  env: Env
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  let query = supabase
    .from('hysa_listings')
    .select('*, institutions(name)')
    .eq('listing_status', 'active')
    .order('apy', { ascending: false })

  if (args.apy_min !== undefined) {
    query = query.gte('apy', args.apy_min)
  }
  if (args.insurance_type !== undefined) {
    query = query.eq('insurance_type', args.insurance_type)
  }
  if (args.monthly_fee_max !== undefined) {
    query = query.lte('monthly_fee', args.monthly_fee_max)
  }
  if (args.apy_rate_variability !== undefined) {
    query = query.eq('apy_rate_variability', args.apy_rate_variability)
  }
  if (args.institution_type !== undefined) {
    query = query.eq('institution_type', args.institution_type)
  }
  if (args.minimum_opening_deposit_max !== undefined) {
    query = query.lte('minimum_opening_deposit', args.minimum_opening_deposit_max)
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

  return results.map((row) => {
    const institutions = row.institutions as { name?: string } | null
    return {
      institution_name: institutions?.name ?? null,
      product_name: row.product_name,
      apy: row.apy,
      apy_rate_variability: row.apy_rate_variability,
      apy_balance_variation: row.apy_balance_variation,
      minimum_balance_to_earn_apy: row.minimum_balance_to_earn_apy,
      minimum_opening_deposit: row.minimum_opening_deposit,
      monthly_fee: row.monthly_fee,
      insurance_type: row.insurance_type,
      available_states: row.available_states,
      application_url: row.application_url,
      last_modified: row.last_modified,
      is_verified: row.is_verified,
    }
  })
}
