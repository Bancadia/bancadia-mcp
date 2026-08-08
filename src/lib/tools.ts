import { TARGET_INDUSTRY_SCHEMA, TARGET_BUSINESS_PROFILE_SCHEMA } from './target-segments'

export const TOOLS = [
  {
    name: 'query_business_checking',
    description:
      'Query the Bancadia registry for business checking account products using compound filter criteria. Returns active, verified listings from financial institutions. Optionally accepts target_industries/target_business_profiles to soft-rank results toward listings built for a given business type or stage — non-matching but eligible listings are still returned, just ranked lower.',
    inputSchema: {
      type: 'object',
      properties: {
        monthly_fee_max: {
          type: 'number',
          description: 'Maximum monthly fee',
        },
        minimum_opening_deposit_max: {
          type: 'number',
          description: 'Maximum minimum opening deposit',
        },
        entity_types_accepted: {
          type: 'array',
          items: { type: 'string' },
          description: 'Returns listings accepting all specified entity types (e.g. llc, s_corp)',
        },
        available_states: {
          type: 'array',
          items: { type: 'string' },
          description: 'Returns listings available in all specified states',
        },
        target_industries: {
          type: 'array',
          items: { type: 'string', ...TARGET_INDUSTRY_SCHEMA },
          description:
            'Soft-ranks results toward listings built for these business types. Does not exclude non-matching but otherwise-eligible listings.',
        },
        target_business_profiles: {
          type: 'array',
          items: { type: 'string', ...TARGET_BUSINESS_PROFILE_SCHEMA },
          description:
            'Soft-ranks results toward listings built for this business stage/shape. Does not exclude non-matching but otherwise-eligible listings.',
        },
        insurance_type: {
          type: 'string',
          enum: ['fdic', 'ncua', 'uninsured'],
          description: 'Deposit insurance type',
        },
        cash_deposit_available: {
          type: 'boolean',
          description: 'Whether cash deposits are supported',
        },
        sub_accounts_supported: {
          type: 'boolean',
          description: 'Whether sub-accounts are supported',
        },
        free_transactions_min: {
          type: 'number',
          description: 'Minimum free transactions per month',
        },
        rtp_supported: {
          type: 'boolean',
          description: 'Whether real-time payments (any rail) are supported at all',
        },
        rtp_network: {
          type: 'string',
          enum: ['fednow', 'rtp_network', 'both', 'none'],
          description: 'Which real-time payment rail is supported',
        },
        accounting_integration_available: {
          type: 'boolean',
          description: 'Whether the account connects to any accounting software (e.g. QuickBooks, Xero)',
        },
        tax_integration_available: {
          type: 'boolean',
          description: 'Whether the account connects to any tax-prep or tax-filing software/service',
        },
        expense_integration_available: {
          type: 'boolean',
          description: 'Whether the account connects to any expense/spend-management software',
        },
        interest_bearing: {
          type: 'boolean',
          description: 'Whether the account earns interest',
        },
        apy_min: {
          type: 'number',
          description: 'Minimum APY (inclusive), for interest-bearing accounts',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_business_checking_listing',
    description:
      "Get full detail on one specific business checking listing, including gotcha fees (business_deposit_fees, e.g. overdraft, NSF, dormancy) and feature narrative (business_deposit_account_features) not returned by query_business_checking's broad list results. Fees/features that apply to only one plan tier (e.g. a Standard/Plus/Premier ladder) are nested under that tier in plan_tiers[].fees / plan_tiers[].features; tier-agnostic ones are in the top-level general_fees / general_features. Use this as a follow-up after query_business_checking to dig deeper on one listing the caller already identified by its listing_slug.",
    inputSchema: {
      type: 'object',
      properties: {
        listing_slug: {
          type: 'string',
          description:
            "The listing's stable public identifier, as returned in query_business_checking results (e.g. 'found-business-checking'). Do not use an internal database id.",
        },
      },
      required: ['listing_slug'],
      additionalProperties: false,
    },
  },
]

export function getToolManifest() {
  return { tools: TOOLS }
}
