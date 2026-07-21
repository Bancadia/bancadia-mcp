import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'
import type { Database } from '../lib/database.types'
import { mapBusinessCheckingRow, type BusinessCheckingQueryRow } from './query-business-checking'

// fee_type values that already have a dedicated flat column on
// business_checking_details (surfaced by query-business-checking.ts's mapper).
// Excluded here so a fee never reaches the model twice from two sources that
// could, in principle, disagree. See docs/business-checking-tool-implementation-plan.md
// Decision 3.
const FEE_TYPES_COVERED_BY_FLAT_COLUMNS = new Set<Database['public']['Enums']['fee_type_enum']>([
  'wire_domestic_outgoing',
  'wire_domestic_incoming',
  'wire_international_outgoing',
  'wire_international_incoming',
  'cash_deposit',
])

type BusinessCheckingDetailRow = BusinessCheckingQueryRow & {
  business_deposit_fees: Database['public']['Tables']['business_deposit_fees']['Row'][]
  business_deposit_account_features: Database['public']['Tables']['business_deposit_account_features']['Row'][]
}

export async function handleGetBusinessCheckingListing(
  args: Record<string, unknown>,
  env: Env
): Promise<object[]> {
  const listingSlug = args.listing_slug
  if (typeof listingSlug !== 'string' || listingSlug.length === 0) {
    return []
  }

  const supabase = createSupabaseClient(env)

  const { data, error } = await supabase
    .from('business_deposit_accounts')
    .select(
      '*, business_checking_details(*), institutions(name, display_name, website_url, logo_url, institution_type, support_email), business_deposit_plan_tiers(*), business_deposit_promotions(*), business_deposit_fees(*), business_deposit_account_features(*)'
    )
    .eq('listing_slug', listingSlug)
    .eq('listing_status', 'active')
    .eq('product_type', 'checking')
    .limit(1)

  if (error || !data || data.length === 0) {
    return []
  }

  const row = data[0] as unknown as BusinessCheckingDetailRow

  return [
    {
      ...mapBusinessCheckingRow(row),
      additional_fees: (row.business_deposit_fees ?? [])
        .filter((f) => !FEE_TYPES_COVERED_BY_FLAT_COLUMNS.has(f.fee_type))
        .map((f) => ({
          fee_type: f.fee_type,
          amount: f.amount,
          amount_description: f.amount_description,
          eligibility_criteria: f.eligibility_criteria,
          tiers: f.tiers,
          waivable: f.waivable,
          waiver_condition: f.waiver_condition,
        })),
      features: (row.business_deposit_account_features ?? [])
        .slice()
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((f) => ({
          category: f.category,
          description: f.description,
          value: f.value,
        })),
    },
  ]
}
