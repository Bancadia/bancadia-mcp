import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'

export async function handleQueryBusinessChecking(
  args: Record<string, unknown>,
  env: Env
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  let query = supabase
    .from('business_checking_listings')
    .select('*, institutions(name)')
    .eq('listing_status', 'active')
    .order('monthly_fee', { ascending: true })

  if (args.monthly_fee_max !== undefined) {
    query = query.lte('monthly_fee', args.monthly_fee_max)
  }
  if (args.minimum_opening_deposit_max !== undefined) {
    query = query.lte('minimum_opening_deposit', args.minimum_opening_deposit_max)
  }
  if (args.cash_deposit_available !== undefined) {
    query = query.eq('cash_deposit_available', args.cash_deposit_available)
  }
  if (args.sub_accounts_supported !== undefined) {
    query = query.eq('sub_accounts_supported', args.sub_accounts_supported)
  }
  if (args.rtp_enabled !== undefined) {
    query = query.eq('rtp_enabled', args.rtp_enabled)
  }
  if (args.free_transactions_min !== undefined) {
    query = query.gte('free_transactions_per_month', args.free_transactions_min)
  }

  const { data, error } = await query

  if (error || !data) {
    return []
  }

  let results = data as Record<string, unknown>[]

  // JS-side filter for entity_types_accepted
  if (Array.isArray(args.entity_types_accepted) && args.entity_types_accepted.length > 0) {
    const requestedTypes = args.entity_types_accepted as string[]
    results = results.filter((row) => {
      const rowTypes = row.entity_types_accepted as string[] | null
      if (!rowTypes) return false
      return requestedTypes.every((t) => rowTypes.includes(t))
    })
  }

  // JS-side filter for integrations
  if (Array.isArray(args.integrations) && args.integrations.length > 0) {
    const requestedIntegrations = args.integrations as string[]
    results = results.filter((row) => {
      const rowIntegrations = row.integrations as string[] | null
      if (!rowIntegrations) return false
      return requestedIntegrations.every((i) => rowIntegrations.includes(i))
    })
  }

  return results.map((row) => {
    const institutions = row.institutions as { name?: string } | null
    return {
      institution_name: institutions?.name ?? null,
      product_name: row.product_name,
      monthly_fee: row.monthly_fee,
      monthly_fee_waiver_condition: row.monthly_fee_waiver_condition,
      free_transactions_per_month: row.free_transactions_per_month,
      entity_types_accepted: row.entity_types_accepted,
      integrations: row.integrations,
      cash_deposit_available: row.cash_deposit_available,
      sub_accounts_supported: row.sub_accounts_supported,
      outgoing_domestic_wire_fee: row.outgoing_domestic_wire_fee,
      application_url: row.application_url,
      last_modified: row.last_modified,
      is_verified: row.is_verified,
    }
  })
}
