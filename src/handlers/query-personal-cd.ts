import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'

export async function handleQueryPersonalCd(
  args: Record<string, unknown>,
  env: Env
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  let query = supabase
    .from('personal_deposit_accounts')
    .select('*, personal_cd_details(*), institutions(name)')
    .eq('listing_status', 'active')
    .eq('product_type', 'cd')
    .order('apy', { ascending: false, foreignTable: 'personal_cd_details' })

  if (args.apy_min !== undefined) {
    query = query.gte('personal_cd_details.apy', args.apy_min)
  }
  if (args.minimum_opening_deposit_max !== undefined) {
    query = query.lte('minimum_opening_deposit', args.minimum_opening_deposit_max)
  }
  if (args.insurance_type !== undefined) {
    query = query.eq('insurance_type', args.insurance_type)
  }
  if (args.term_months_min !== undefined) {
    query = query.gte('personal_cd_details.term_months', args.term_months_min)
  }
  if (args.term_months_max !== undefined) {
    query = query.lte('personal_cd_details.term_months', args.term_months_max)
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

  // JS-side filter for auto_renew
  if (args.auto_renew !== undefined) {
    const requested = args.auto_renew as boolean
    results = results.filter((row) => {
      const details = row.personal_cd_details as Record<string, unknown> | null
      return details?.auto_renew === requested
    })
  }

  return results.map((row) => {
    const institutions = row.institutions as { name?: string } | null
    const details = row.personal_cd_details as Record<string, unknown> | null
    return {
      institution_name: institutions?.name ?? null,
      product_name: row.product_name,
      apy: details?.apy ?? null,
      term_months: details?.term_months ?? null,
      maturity_date: details?.maturity_date ?? null,
      early_withdrawal_penalty_days: details?.early_withdrawal_penalty_days ?? null,
      auto_renew: details?.auto_renew ?? null,
      minimum_opening_deposit: row.minimum_opening_deposit,
      insurance_type: row.insurance_type,
      available_states: row.available_states,
      application_url: row.application_url,
      last_modified: row.last_modified,
      is_verified: row.is_verified,
    }
  })
}
