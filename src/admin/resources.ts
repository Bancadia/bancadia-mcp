import { z } from 'zod'
import type { TablesInsert, TablesUpdate } from '../lib/database.types'

// One entry per listing sub-resource. The table, the strict body schema and the readable columns live in one
// place, so adding a column means touching one line here. `satisfies` ties every key to the generated DB types,
// so a typo or a dropped column fails the compile.
//
// Enum-typed columns are plain strings here on purpose: the database is the authority, so a value added through
// POST /enums/... works immediately with no redeploy (a bad value comes back as 22P02 -> 422).
// Never listed, so never writable or readable through this API: tsv, tracker_url, is_affiliate_tracked.

const s = z.string().trim().min(1)
const sn = z.string().nullable().optional()
const num = z.number().finite()
const numN = num.nullable().optional()
const int = z.number().int()
const intN = int.nullable().optional()
const bool = z.boolean()
const uuidN = z.uuid().nullable().optional()
const json = z.json().nullable().optional()
type Shape<T> = Partial<Record<keyof T, z.ZodType>>

const feeShape = {
  fee_type: s,
  description: s,
  amount: numN,
  amount_description: sn,
  eligibility_criteria: sn,
  waiver_condition: sn,
  waivable: bool.optional(),
  tiers: json,
  plan_tier_id: uuidN,
  source_url: sn,
  as_of: sn,
  fee_unit: sn,
  free_allowance_amount: numN,
  free_allowance_unit: z.enum(['usd', 'count']).nullable().optional(),
  allowance_period: z.enum(['month', 'year', 'once']).nullable().optional(),
  fee_min_amount: numN,
  fee_max_amount: numN,
  amount_status: sn,
} satisfies Shape<TablesInsert<'business_deposit_fees'>>

const featureShape = {
  category: s,
  description: s,
  sort_order: intN,
  plan_tier_id: uuidN,
  value: numN,
  source_url: sn,
  source_page: sn,
  as_of: sn,
  source: s.optional(),
  limit_key: sn,
  value_unit: sn,
} satisfies Shape<TablesInsert<'business_deposit_account_features'>>

const promotionShape = {
  bonus_amount: int,
  condition_description: s,
  minimum_deposit: intN,
  expiry_date: sn,
  promo_url: sn,
} satisfies Shape<TablesInsert<'business_deposit_promotions'>>

const planTierShape = {
  plan_name: s,
  sort_order: int.optional(),
  monthly_fee: num.optional(),
  monthly_fee_waiver_condition: sn,
  apy: numN,
  apy_max_balance_eligible: intN,
  apy_condition: sn,
  is_default: bool.optional(),
} satisfies Shape<TablesInsert<'business_deposit_plan_tiers'>>

const targetSegmentShape = {
  category: s,
  segment: s,
} satisfies Shape<TablesInsert<'business_deposit_account_target_segments'>>

export type Resource = {
  table: string
  shape: Record<string, z.ZodType>
  readonly: string[]
  order: string[]
}

export const RESOURCES = {
  fees: { table: 'business_deposit_fees', shape: feeShape, readonly: ['created_at'], order: ['created_at'] },
  features: {
    table: 'business_deposit_account_features', shape: featureShape, readonly: ['created_at'],
    order: ['sort_order', 'created_at'],
  },
  promotions: { table: 'business_deposit_promotions', shape: promotionShape, readonly: ['created_at'], order: ['created_at'] },
  'plan-tiers': {
    table: 'business_deposit_plan_tiers', shape: planTierShape, readonly: ['created_at', 'updated_at'],
    order: ['sort_order', 'created_at'],
  },
  'target-segments': {
    table: 'business_deposit_account_target_segments', shape: targetSegmentShape, readonly: ['created_at'],
    order: ['created_at'],
  },
} satisfies Record<string, Resource>

export type ResourceName = keyof typeof RESOURCES

export const columnsOf = (r: Resource) => ['id', 'listing_id', ...Object.keys(r.shape), ...r.readonly]
export const createSchema = (r: Resource) => z.strictObject(r.shape)
export const updateSchema = (r: Resource) => z.strictObject(r.shape).partial()

// ── /details: business_deposit_accounts + business_checking_details ──────────────────────────────────────────
// Mirrors the column allowlist inside admin_update_details (098). Anything outside it is rejected by the DB too.
const accountShape = {
  product_name: s,
  application_url: s,
  application_method: sn,
  product_disclosure_overview_url: sn,
  minimum_opening_deposit: int,
  minimum_balance_to_waive_fee: intN,
  monthly_fee: num,
  monthly_fee_waiver_condition: sn,
  insurance_type: s,
  deposit_insurance_limit: int,
  deposit_insurance_extended: bool,
  deposit_insurance_extended_limit: intN,
  available_states: z.array(s),
  entity_types_accepted: z.array(s).min(1),
  time_in_business_required_months: intN,
  minimum_annual_revenue: intN,
  us_based_business_required: bool,
  multiple_accounts_allowed: bool,
  affiliate_disclosure: sn,
  verification_source: sn,
  effective_date: sn,
  expiry_date: sn,
  country: s,
  currency: s,
  custom_fields: json,
} satisfies Shape<TablesUpdate<'business_deposit_accounts'>>

const checkingShape = {
  free_transactions_per_month: intN,
  per_transaction_fee_after_limit: numN,
  outgoing_domestic_wire_fee: numN,
  free_domestic_wires_per_month: intN,
  outgoing_international_wire_fee: numN,
  incoming_domestic_wire_fee: num,
  incoming_international_wire_fee: numN,
  cash_deposit_available: bool,
  cash_deposit_fee_per_100: numN,
  monthly_cash_deposit_limit: intN,
  interest_bearing: bool,
  apy_max: numN,
  apy_default: numN,
  apy_tiers: json,
  rtp_supported: bool,
  rtp_network: sn,
  accounting_integration_available: bool,
  tax_integration_available: bool,
  expense_integration_available: bool,
  physical_debit_card_available: bool,
  virtual_cards_available: bool,
  corporate_card_available: bool,
  atm_fee_reimbursement: bool,
  atm_fee_reimbursement_limit: numN,
  atm_network: sn,
  sub_accounts_supported: bool,
  savings_buckets_supported: bool,
  check_writing_available: bool,
  bill_pay_available: bool,
  remote_deposit_capture: bool,
  positive_pay_available: bool,
  overdraft_protection_available: bool,
  overdraft_line_of_credit_available: bool,
  ach_debit_block_available: bool,
  multicurrency_support: bool,
  daily_debit_limit: intN,
} satisfies Shape<TablesUpdate<'business_checking_details'>>

export const detailsSchema = z.strictObject({
  account: z.strictObject(accountShape).partial().optional(),
  checking: z.strictObject(checkingShape).partial().optional(),
})

// Read-only context shown beside the editable account fields.
const ACCOUNT_READONLY = [
  'id', 'listing_slug', 'institution_id', 'product_type', 'listing_status', 'scheduled_publish_at', 'is_verified',
  'staleness_flag', 'agent_matching_paused', 'schema_version', 'last_modified', 'last_verified', 'created_at',
]
export const ACCOUNT_COLUMNS = [...ACCOUNT_READONLY, ...Object.keys(accountShape)]
export const CHECKING_COLUMNS = ['listing_id', ...Object.keys(checkingShape)]

// ── feature integrations (composite key feature_id + integration_slug) ───────────────────────────────────────
export const INTEGRATION_COLUMNS = ['feature_id', 'integration_slug', 'connection_method', 'note']
const integrationFields = {
  connection_method: z.enum(['native', 'third_party', 'file_export']).nullable().optional(),
  note: sn,
}
export const integrationCreateSchema = z.strictObject({ integration_slug: s, ...integrationFields })
export const integrationUpdateSchema = z.strictObject(integrationFields)

// resources with enum dropdowns: the names admin_field_enums (099) understands
export const ENUM_RESOURCES = ['details', 'fees', 'features', 'promotions', 'plan-tiers', 'target-segments', 'integrations']
export const enumValueSchema = z.strictObject({ value: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/) })

export const pick = (row: Record<string, unknown> | null | undefined, cols: string[]) =>
  row ? Object.fromEntries(cols.filter((k) => k in row).map((k) => [k, row[k]])) : row
