import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'
import type { Database } from '../lib/database.types'

type BusinessCheckingQueryRow = Database['public']['Tables']['business_deposit_accounts']['Row'] & {
  business_checking_details: Database['public']['Tables']['business_checking_details']['Row'] | null
  institutions: { name: string } | null
  business_deposit_plan_tiers: Database['public']['Tables']['business_deposit_plan_tiers']['Row'][]
  business_deposit_promotions: Database['public']['Tables']['business_deposit_promotions']['Row'][]
}

export async function handleQueryBusinessChecking(
  args: Record<string, unknown>,
  env: Env
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  let query = supabase
    .from('business_deposit_accounts')
    .select(
      '*, business_checking_details(*), institutions(name), business_deposit_plan_tiers(*), business_deposit_promotions(*)'
    )
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
    query = query.eq('insurance_type', args.insurance_type as Database['public']['Enums']['insurance_type_enum'])
  }
  if (args.cash_deposit_available !== undefined) {
    query = query.eq('business_checking_details.cash_deposit_available', args.cash_deposit_available as boolean)
  }
  if (args.sub_accounts_supported !== undefined) {
    query = query.eq('business_checking_details.sub_accounts_supported', args.sub_accounts_supported as boolean)
  }
  if (args.rtp_supported !== undefined) {
    query = query.eq('business_checking_details.rtp_supported', args.rtp_supported as boolean)
  }
  if (args.rtp_network !== undefined) {
    query = query.eq(
      'business_checking_details.rtp_network',
      args.rtp_network as Database['public']['Enums']['rtp_network_enum']
    )
  }
  if (args.accounting_integration_available !== undefined) {
    query = query.eq(
      'business_checking_details.accounting_integration_available',
      args.accounting_integration_available as boolean
    )
  }
  if (args.tax_integration_available !== undefined) {
    query = query.eq(
      'business_checking_details.tax_integration_available',
      args.tax_integration_available as boolean
    )
  }
  if (args.expense_integration_available !== undefined) {
    query = query.eq(
      'business_checking_details.expense_integration_available',
      args.expense_integration_available as boolean
    )
  }
  if (args.interest_bearing !== undefined) {
    query = query.eq('business_checking_details.interest_bearing', args.interest_bearing as boolean)
  }
  if (args.free_transactions_min !== undefined) {
    query = query.gte('business_checking_details.free_transactions_per_month', args.free_transactions_min)
  }
  if (args.apy_min !== undefined) {
    query = query.gte('business_checking_details.apy', args.apy_min)
  }

  const { data, error } = await query

  if (error || !data) {
    return []
  }

  let results = data as unknown as BusinessCheckingQueryRow[]

  // JS-side filter for entity_types_accepted
  if (Array.isArray(args.entity_types_accepted) && args.entity_types_accepted.length > 0) {
    const requestedTypes = args.entity_types_accepted as string[]
    results = results.filter((row) => {
      const rowTypes = row.entity_types_accepted
      if (!rowTypes) return false
      return requestedTypes.every((t) => (rowTypes as string[]).includes(t))
    })
  }

  // JS-side filter for available_states ('ALL' wildcard)
  if (Array.isArray(args.available_states) && args.available_states.length > 0) {
    const requestedStates = args.available_states as string[]
    results = results.filter((row) => {
      const rowStates = row.available_states
      if (!rowStates) return false
      if (rowStates.includes('ALL')) return true
      return requestedStates.every((s) => rowStates.includes(s))
    })
  }

  return results.map((row) => {
    const details = row.business_checking_details
    return {
      institution_name: row.institutions?.name ?? null,
      product_name: row.product_name,
      monthly_fee: row.monthly_fee,
      monthly_fee_waiver_condition: row.monthly_fee_waiver_condition,
      minimum_opening_deposit: row.minimum_opening_deposit,
      entity_types_accepted: row.entity_types_accepted,
      available_states: row.available_states,
      insurance_type: row.insurance_type,
      free_transactions_per_month: details?.free_transactions_per_month ?? null,
      cash_deposit_available: details?.cash_deposit_available ?? null,
      sub_accounts_supported: details?.sub_accounts_supported ?? null,
      rtp_supported: details?.rtp_supported ?? null,
      rtp_network: details?.rtp_network ?? null,
      accounting_integration_available: details?.accounting_integration_available ?? null,
      tax_integration_available: details?.tax_integration_available ?? null,
      expense_integration_available: details?.expense_integration_available ?? null,
      interest_bearing: details?.interest_bearing ?? null,
      apy: details?.apy ?? null,
      apy_tiers: details?.apy_tiers ?? null,
      outgoing_domestic_wire_fee: details?.outgoing_domestic_wire_fee ?? null,
      plan_tiers: (row.business_deposit_plan_tiers ?? []).map((t) => ({
        plan_name: t.plan_name,
        monthly_fee: t.monthly_fee,
        monthly_fee_waiver_condition: t.monthly_fee_waiver_condition,
        apy: t.apy,
        apy_max_balance_eligible: t.apy_max_balance_eligible,
        apy_condition: t.apy_condition,
        is_default: t.is_default,
        sort_order: t.sort_order,
      })),
      promotions: (row.business_deposit_promotions ?? []).map((p) => ({
        bonus_amount: p.bonus_amount,
        condition_description: p.condition_description,
        minimum_deposit: p.minimum_deposit,
        expiry_date: p.expiry_date,
        promo_url: p.promo_url,
      })),
      application_url: row.application_url,
      last_modified: row.last_modified,
      is_verified: row.is_verified,
    }
  })
}
