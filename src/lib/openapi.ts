import { TOOLS } from './tools'
import { Constants } from './database.types'

type Schema = Record<string, unknown>

const E = Constants.public.Enums
const toolSchema = (name: string) =>
  TOOLS.find((t) => t.name === name)!.inputSchema as unknown as { properties: Record<string, Schema>; required?: string[] }

const nullable = (type: string, extra: Schema = {}): Schema => ({ type: [type, 'null'], ...extra })
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const TRACKED_LINK =
  'Each result\'s application_url is a tracked Bancadia link: give it to the user exactly as returned, including its query string.'

// Mirrors the object returned by mapBusinessCheckingRow (src/handlers/query-business-checking.ts).
// A contract test fails if the mapper's keys and these properties diverge.
const planTierProps: Record<string, Schema> = {
  plan_name: { type: 'string' },
  monthly_fee: { type: 'number' },
  monthly_fee_waiver_condition: nullable('string'),
  apy: nullable('number'),
  apy_max_balance_eligible: nullable('number'),
  apy_condition: nullable('string'),
  is_default: { type: 'boolean' },
  sort_order: { type: 'integer' },
}

const listingProps: Record<string, Schema> = {
  listing_slug: { type: 'string', description: 'Stable public identifier; use it with GET /business-checking/{listing_slug}.' },
  institution_name: nullable('string'),
  institution: {
    type: ['object', 'null'],
    properties: {
      display_name: nullable('string'),
      website_url: nullable('string'),
      logo_url: nullable('string'),
      institution_type: { type: 'string', enum: [...E.institution_type_enum] },
      support_email: nullable('string'),
    },
  },
  product_name: { type: 'string' },
  monthly_fee: { type: 'number', description: 'Monthly fee in USD.' },
  monthly_fee_waiver_condition: nullable('string'),
  minimum_opening_deposit: { type: 'number' },
  entity_types_accepted: { type: 'array', items: { type: 'string', enum: [...E.entity_type_enum] } },
  available_states: { type: 'array', items: { type: 'string' }, description: "Two-letter state codes; ['ALL'] means every state." },
  target_industries: { type: 'array', items: { type: 'string' }, description: 'Business types the listing is built for.' },
  target_business_profiles: { type: 'array', items: { type: 'string' }, description: 'Business stages the listing is built for.' },
  insurance_type: { type: 'string', enum: [...E.insurance_type_enum] },
  free_transactions_per_month: nullable('integer'),
  cash_deposit_available: nullable('boolean'),
  cash_deposit_fee_per_100: nullable('number'),
  monthly_cash_deposit_limit: nullable('number'),
  sub_accounts_supported: nullable('boolean'),
  rtp_supported: nullable('boolean'),
  rtp_network: { type: ['string', 'null'], enum: [...E.rtp_network_enum, null] },
  accounting_integration_available: nullable('boolean'),
  tax_integration_available: nullable('boolean'),
  expense_integration_available: nullable('boolean'),
  interest_bearing: nullable('boolean'),
  apy_max: nullable('number', { description: 'Best rate the account can pay, as a decimal (0.02 = 2%).' }),
  apy_default: nullable('number', { description: 'Standard rate, as a decimal.' }),
  apy_tiers: { description: 'Balance-tiered rates, structure varies by institution. Null when not applicable.' },
  outgoing_domestic_wire_fee: nullable('number'),
  incoming_domestic_wire_fee: nullable('number'),
  outgoing_international_wire_fee: nullable('number'),
  incoming_international_wire_fee: nullable('number'),
  multicurrency_support: nullable('boolean'),
  free_domestic_wires_per_month: nullable('integer'),
  per_transaction_fee_after_limit: nullable('number'),
  atm_fee_reimbursement: nullable('boolean'),
  atm_fee_reimbursement_limit: nullable('number'),
  atm_network: nullable('string'),
  overdraft_protection_available: nullable('boolean'),
  overdraft_line_of_credit_available: nullable('boolean'),
  daily_debit_limit: nullable('number'),
  ach_debit_block_available: nullable('boolean'),
  positive_pay_available: nullable('boolean'),
  remote_deposit_capture: nullable('boolean'),
  bill_pay_available: nullable('boolean'),
  check_writing_available: nullable('boolean'),
  corporate_card_available: nullable('boolean'),
  virtual_cards_available: nullable('boolean'),
  physical_debit_card_available: nullable('boolean'),
  plan_tiers: { type: 'array', items: { type: 'object', properties: planTierProps } },
  promotions: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        bonus_amount: { type: 'number' },
        condition_description: { type: 'string' },
        minimum_deposit: nullable('number'),
        expiry_date: nullable('string', { format: 'date' }),
        promo_url: nullable('string'),
      },
    },
  },
  application_url: {
    type: 'string',
    description: 'Tracked Bancadia link to apply. Give it to the user exactly as returned, including its query string.',
  },
  last_modified: { type: 'string' },
  is_verified: { type: 'boolean' },
}

const featureSchema = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: [...E.feature_category_enum] },
    description: { type: 'string' },
    value: nullable('number'),
  },
}
const feeSchema = {
  type: 'object',
  properties: {
    fee_type: { type: 'string', enum: [...E.fee_type_enum] },
    amount: nullable('number'),
    amount_description: nullable('string'),
    eligibility_criteria: nullable('string'),
    tiers: { description: 'Tiered fee structure, varies by fee. Null when not applicable.' },
    waivable: { type: 'boolean' },
    waiver_condition: nullable('string'),
  },
}

const detailProps: Record<string, Schema> = {
  ...listingProps,
  plan_tiers: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        ...planTierProps,
        features: { type: 'array', items: featureSchema },
        fees: { type: 'array', items: feeSchema },
      },
    },
  },
  general_fees: { type: 'array', items: feeSchema, description: 'Fees that apply to every plan tier.' },
  general_features: { type: 'array', items: featureSchema, description: 'Features that apply to every plan tier.' },
}

// Example values by type, so the example always carries every documented key.
const sample = (props: Record<string, Schema>, over: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(props).map(([k, s]) => {
      const t = [s.type].flat()[0]
      const base = t === 'boolean' ? false : t === 'number' || t === 'integer' ? 0 : t === 'array' ? [] : t === 'object' ? null : t === 'string' ? '' : null
      return [k, k in over ? over[k] : base]
    })
  )

const listingExample = sample(listingProps, {
  listing_slug: 'found-business-checking',
  institution_name: 'Found',
  institution: {
    display_name: 'Found',
    website_url: 'https://found.com',
    logo_url: 'https://found.com/logo.png',
    institution_type: 'fintech',
    support_email: 'support@found.com',
  },
  product_name: 'Found Business Checking',
  entity_types_accepted: ['llc', 'sole_prop'],
  available_states: ['ALL'],
  insurance_type: 'fdic',
  rtp_network: 'none',
  application_url: 'https://bancadia.com/go/found/business-checking?src=rest&qr=00000000-0000-4000-8000-000000000000',
  last_modified: '2026-01-01T00:00:00Z',
  is_verified: true,
})
const detailExample = { ...sample(detailProps, listingExample), general_fees: [], general_features: [] }

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
})

const errors = {
  '400': problemResponse('Bad or unknown parameter.'),
  '401': problemResponse('An Authorization header was sent but the token is invalid or revoked. Omit it to call anonymously.'),
  '429': {
    ...problemResponse('Rate limit exceeded.'),
    headers: { 'Retry-After': { description: 'Seconds to wait before retrying.', schema: { type: 'integer' } } },
  },
  '500': problemResponse('Database or internal failure. Safe to retry.'),
}

const headers = {
  'X-Request-Id': { description: 'Unique id for this request.', schema: { type: 'string' } },
  'RateLimit-Limit': { description: 'Requests allowed in the current window.', schema: { type: 'integer' } },
  'RateLimit-Remaining': { description: 'Requests left in the current window.', schema: { type: 'integer' } },
  'RateLimit-Reset': { description: 'Seconds until the window resets.', schema: { type: 'integer' } },
}

export function buildOpenApi() {
  const q = toolSchema('query_business_checking')
  const d = toolSchema('get_business_checking_listing')
  const desc = (name: string) => TOOLS.find((t) => t.name === name)!.description

  const queryParameters = Object.entries(q.properties).map(([name, { description, ...schema }]) => ({
    name,
    in: 'query',
    required: false,
    description,
    schema,
    ...(schema.type === 'array' ? { style: 'form', explode: false } : {}),
  }))
  const { description: slugDescription, ...slugSchema } = d.properties.listing_slug!

  return {
    openapi: '3.1.0',
    info: {
      title: 'Bancadia Business Checking API',
      version: '1.0.0',
      summary: 'Compare U.S. business checking accounts with structured filters.',
      description: `Read-only JSON API over Bancadia's registry of verified business checking account products. No API key is required; an optional bearer token raises rate limits and attributes usage to your developer account. ${TRACKED_LINK}`,
      contact: { name: 'Bancadia', email: 'hello@bancadia.com', url: 'https://bancadia.com' },
    },
    servers: [{ url: 'https://api.bancadia.com/v1' }],
    externalDocs: { description: 'REST API documentation', url: 'https://bancadia.com/docs/rest-api' },
    tags: [{ name: 'Business checking', description: 'Business checking account listings.' }],
    security: [{}, { bearerAuth: [] }],
    paths: {
      '/business-checking': {
        get: {
          operationId: 'searchBusinessCheckingAccounts',
          summary: 'Search business checking accounts',
          description: `Use this to find business checking accounts matching filter criteria; with no parameters it returns every active listing. ${desc('query_business_checking')} Array parameters are comma-separated (entity_types_accepted=llc,s_corp). Unknown parameters return 400.`,
          tags: ['Business checking'],
          parameters: queryParameters,
          responses: {
            '200': {
              description: 'Matching listings.',
              headers,
              content: {
                'application/json': {
                  schema: ref('ListResponse'),
                  example: {
                    data: [listingExample],
                    meta: { count: 1, request_id: '00000000-0000-4000-8000-000000000000', filters: { monthly_fee_max: 0 } },
                  },
                },
              },
            },
            ...errors,
          },
        },
      },
      '/business-checking/{listing_slug}': {
        get: {
          operationId: 'getBusinessCheckingAccount',
          summary: 'Get one business checking account',
          description: `Use this after a search to get full detail (fees, features, plan tiers) on one listing by its listing_slug. ${TRACKED_LINK}`,
          tags: ['Business checking'],
          parameters: [
            { name: 'listing_slug', in: 'path', required: true, description: slugDescription, schema: slugSchema },
          ],
          responses: {
            '200': {
              description: 'The listing.',
              headers,
              content: {
                'application/json': {
                  schema: ref('DetailResponse'),
                  example: {
                    data: detailExample,
                    meta: { count: 1, request_id: '00000000-0000-4000-8000-000000000000' },
                  },
                },
              },
            },
            ...errors,
            '404': problemResponse('No listing with that listing_slug.'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Optional. A developer token attributes your usage and uses your own rate limit instead of the shared per-IP one. Get one at https://bancadia.com/developer/signup.',
        },
      },
      schemas: {
        BusinessCheckingListing: { type: 'object', properties: listingProps },
        BusinessCheckingListingDetail: { type: 'object', properties: detailProps },
        ListResponse: {
          type: 'object',
          required: ['data', 'meta'],
          properties: {
            data: { type: 'array', items: ref('BusinessCheckingListing') },
            meta: {
              type: 'object',
              required: ['count', 'request_id', 'filters'],
              properties: {
                count: { type: 'integer' },
                request_id: { type: 'string' },
                filters: { type: 'object', description: 'The parsed filters that were applied.', additionalProperties: true },
              },
            },
          },
        },
        DetailResponse: {
          type: 'object',
          required: ['data', 'meta'],
          properties: {
            data: ref('BusinessCheckingListingDetail'),
            meta: {
              type: 'object',
              required: ['count', 'request_id'],
              properties: { count: { type: 'integer' }, request_id: { type: 'string' } },
            },
          },
        },
        Problem: {
          type: 'object',
          description: 'RFC 9457 problem details.',
          required: ['type', 'title', 'status', 'detail'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
          },
        },
      },
    },
  }
}
