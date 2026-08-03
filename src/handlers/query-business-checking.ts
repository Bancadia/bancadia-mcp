import { createSupabaseClient } from '../lib/supabase'
import { recordMatchEvents, type QueryMeta } from '../lib/analytics'
import type { Env } from '../types'
import type { Database } from '../lib/database.types'

export type BusinessCheckingQueryRow = Database['public']['Tables']['business_deposit_accounts']['Row'] & {
  business_checking_details: Database['public']['Tables']['business_checking_details']['Row'] | null
  institutions: {
    name: string
    display_name: string | null
    website_url: string | null
    logo_url: string | null
    institution_type: Database['public']['Enums']['institution_type_enum']
    support_email: string | null
  } | null
  business_deposit_plan_tiers: Database['public']['Tables']['business_deposit_plan_tiers']['Row'][]
  business_deposit_promotions: Database['public']['Tables']['business_deposit_promotions']['Row'][]
}

// Filters below that read a business_checking_details column via a dot-path
// (e.g. 'business_checking_details.accounting_integration_available') only
// restrict which parent rows come back when the embed uses the `!inner` join
// hint — without it, PostgREST applies the filter to shape the embedded
// object only, not to exclude the row. We add `!inner` conditionally (only
// when one of these filters is actually requested) so that a query with no
// details-table filter still surfaces listings that don't yet have a
// business_checking_details row.
const DETAILS_FILTER_KEYS = [
  'cash_deposit_available',
  'sub_accounts_supported',
  'rtp_supported',
  'rtp_network',
  'accounting_integration_available',
  'tax_integration_available',
  'expense_integration_available',
  'interest_bearing',
  'free_transactions_min',
  'apy_min',
] as const

export async function handleQueryBusinessChecking(
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
  meta: QueryMeta
): Promise<object[]> {
  const supabase = createSupabaseClient(env)

  const needsDetailsInner = DETAILS_FILTER_KEYS.some((key) => args[key] !== undefined)

  let query = supabase
    .from('business_deposit_accounts')
    .select(
      `*, business_checking_details${needsDetailsInner ? '!inner' : ''}(*), institutions(name, display_name, website_url, logo_url, institution_type, support_email), business_deposit_plan_tiers(*), business_deposit_promotions(*)`
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

  ctx.waitUntil(
    recordMatchEvents(
      env,
      meta,
      args,
      results.map((row) => ({
        listingId: row.id,
        institutionId: row.institution_id,
        listingSlug: row.listing_slug ?? null,
      }))
    )
  )

  return results.map(mapBusinessCheckingRow)
}

// Shared with get-business-checking-listing.ts, which reuses this base shape
// and layers on additional_fees/features for the single-listing detail view.
export function mapBusinessCheckingRow(row: BusinessCheckingQueryRow) {
  const details = row.business_checking_details
  return {
    listing_slug: row.listing_slug,
    institution_name: row.institutions?.name ?? null,
    institution: row.institutions
      ? {
          display_name: row.institutions.display_name,
          website_url: row.institutions.website_url,
          logo_url: row.institutions.logo_url,
          institution_type: row.institutions.institution_type,
          support_email: row.institutions.support_email,
        }
      : null,
    product_name: row.product_name,
    monthly_fee: row.monthly_fee,
    monthly_fee_waiver_condition: row.monthly_fee_waiver_condition,
    minimum_opening_deposit: row.minimum_opening_deposit,
    entity_types_accepted: row.entity_types_accepted,
    available_states: row.available_states,
    insurance_type: row.insurance_type,
    free_transactions_per_month: details?.free_transactions_per_month ?? null,
    cash_deposit_available: details?.cash_deposit_available ?? null,
    cash_deposit_fee_per_100: details?.cash_deposit_fee_per_100 ?? null,
    monthly_cash_deposit_limit: details?.monthly_cash_deposit_limit ?? null,
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
    incoming_domestic_wire_fee: details?.incoming_domestic_wire_fee ?? null,
    outgoing_international_wire_fee: details?.outgoing_international_wire_fee ?? null,
    incoming_international_wire_fee: details?.incoming_international_wire_fee ?? null,
    multicurrency_support: details?.multicurrency_support ?? null,
    free_domestic_wires_per_month: details?.free_domestic_wires_per_month ?? null,
    per_transaction_fee_after_limit: details?.per_transaction_fee_after_limit ?? null,
    atm_fee_reimbursement: details?.atm_fee_reimbursement ?? null,
    atm_fee_reimbursement_limit: details?.atm_fee_reimbursement_limit ?? null,
    atm_network: details?.atm_network ?? null,
    overdraft_protection_available: details?.overdraft_protection_available ?? null,
    overdraft_line_of_credit_available: details?.overdraft_line_of_credit_available ?? null,
    daily_debit_limit: details?.daily_debit_limit ?? null,
    ach_debit_block_available: details?.ach_debit_block_available ?? null,
    positive_pay_available: details?.positive_pay_available ?? null,
    remote_deposit_capture: details?.remote_deposit_capture ?? null,
    bill_pay_available: details?.bill_pay_available ?? null,
    check_writing_available: details?.check_writing_available ?? null,
    corporate_card_available: details?.corporate_card_available ?? null,
    virtual_cards_available: details?.virtual_cards_available ?? null,
    physical_debit_card_available: details?.physical_debit_card_available ?? null,
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
}
