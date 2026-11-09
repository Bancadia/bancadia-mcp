import { TOOLS_V2 } from './tools-v2'

type Schema = Record<string, unknown>
type ToolSchema = { properties: Record<string, Schema>; required?: readonly string[] }

const tool = (name: string) => TOOLS_V2.find((t) => t.name === name)!
const toolSchema = (name: string) => tool(name).inputSchema as unknown as ToolSchema
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

const TRACKED_LINK =
  "Every bank row's application_url is a tracked Bancadia link: give it to the user exactly as returned, including its query string."
const ID = '00000000-0000-4000-8000-000000000000'
const URL_EXAMPLE = `https://bancadia.com/go/found/online-business-checking?src=rest&qr=${ID}`

// Query parameters are the tool's input properties (arrays comma separated; min_limits as key:number pairs).
function parameters(name: string, only?: string[]) {
  return Object.entries(toolSchema(name).properties)
    .filter(([k]) => !only || only.includes(k))
    .map(([k, { description, ...schema }]) => {
      const object = schema.type === 'object'
      return {
        name: k,
        in: 'query',
        required: (toolSchema(name).required ?? []).includes(k),
        description: object ? `${description}. Comma-separated key:number pairs, e.g. sub_accounts:12,free_wires:2.` : description,
        schema: object ? { type: 'string' } : schema,
        ...(schema.type === 'array' ? { style: 'form', explode: false } : {}),
      }
    })
}

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ref('Problem') } },
})

const errors = {
  '400': problemResponse('Bad or unknown parameter. The detail lists the valid values.'),
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

const ok = (description: string, schema: Schema, example: unknown) => ({
  description,
  headers,
  content: { 'application/json': { schema, example } },
})

const meta = (extra: Record<string, Schema> = {}, required: string[] = []) => ({
  type: 'object',
  required: ['count', 'request_id', 'filters', ...required],
  properties: {
    count: { type: 'integer', description: 'Number of items in data.' },
    request_id: { type: 'string' },
    filters: { type: 'object', description: 'The parsed arguments that were applied.', additionalProperties: true },
    ...extra,
  },
})
const envelope = (data: Schema, m: Schema) => ({ type: 'object', required: ['data', 'meta'], properties: { data, meta: m } })
const arrayOf = (name: string) => ({ type: 'array', items: ref(name) })
const meta0 = { count: 1, request_id: ID, filters: {} }

const bankRow = { listing_slug: 'found-online-business-checking', institution_name: 'Indie Technologies, Inc. dba Found', product_name: 'Found Business Checking', monthly_fee: 0, minimum_opening_deposit: 0, insurance_type: 'fdic', apy_max: 0.0125, apy_default: 0.0125, free_transactions_per_month: 0, application_url: URL_EXAMPLE }
const fact = { topic: 'fees', plan: 'all plans', snippet: 'One free cash deposit each month; after that a $2.00 fee ...', source_url: 'https://found.com/help/can-i-deposit-cash', as_of: '2026-11-09' }
const feeRow = { fee_type: 'cash_deposit', plan: 'all plans', amount: 2, amount_status: 'set', fee_unit: 'per_transaction', description: 'Cash deposit fee' }
const listingDetail = { slug: 'found-online-business-checking', application_url: URL_EXAMPLE, detail_has: ['tiers:1', 'fees:17'], tiers: [{ plan_name: 'Standard', monthly_fee: 0, is_default: true }] }

const L = '/business-checking-listings'
const WILDCARD = 'Use - in place of {listing_slug} to read across all listings.'
const slugParam = {
  name: 'listing_slug', in: 'path', required: true,
  description: "The listing's stable public identifier, as returned by the list route. The literal - is not a slug (it is the all-listings wildcard).",
  schema: { type: 'string' },
}

const section = (route: string, title: string, key: string) => ({
  get: {
    operationId: `getBusinessCheckingListing${title}`,
    summary: `Get a listing's ${route}`,
    description: `Returns only the ${route} section of one listing (the same rows as get_listing sections=${key}). Takes no query parameters. data is that section's array (empty when the listing has none); meta.listing carries listing_slug and its tracked application_url. ${TRACKED_LINK}`,
    tags: ['Business checking'],
    parameters: [slugParam],
    responses: {
      '200': ok(`The listing's ${route}.`, ref('SectionResponse'), {
        data: [], meta: { ...meta0, count: 0, listing: { listing_slug: 'found-online-business-checking', application_url: URL_EXAMPLE } },
      }),
      ...errors,
      '404': problemResponse('No listing with that listing_slug.'),
    },
  },
})

export function buildOpenApi() {
  const list = {
    operationId: 'listBusinessCheckingListings',
    summary: 'List business checking listings',
    description: `Find business checking accounts matching filter criteria. Returns up to limit rows (default 7, max 20, clamped; the effective limit is in meta.limit); page with offset and meta.next_offset. data is an array of rows; paging and extras (total_matches, matches_overview, excluded_by, possible_matches) are in meta. Select more columns with fields. Array parameters are comma-separated. Unknown parameters return 400. ${TRACKED_LINK}`,
    tags: ['Business checking'],
    parameters: parameters('list_business_checking'),
    responses: {
      '200': ok('Matching listings.', ref('ListResponse'), {
        data: [bankRow],
        meta: { count: 1, request_id: ID, filters: { monthly_fee_max: 0, limit: 1 }, total_matches: 13, returned: 1, limit: 1, next_offset: 1, notes: 'Absent field = not offered or not published.', hint: 'Free-text fee and feature details are searchable: call search_facts(query, slugs) or get_listing(slugs, sections).', excluded_by: {}, matches_overview: [{ slug: 'found-online-business-checking', name: 'Indie Technologies, Inc. dba Found' }] },
      }),
      ...errors,
    },
  }
  const single = {
    operationId: 'getBusinessCheckingListing',
    summary: 'Get one business checking listing',
    description: `Detail on one listing by its listing_slug; choose sections (summary, tiers, fees, features, promotions). ${TRACKED_LINK}`,
    tags: ['Business checking'],
    parameters: [slugParam, ...parameters('get_listing', ['sections'])],
    responses: {
      '200': ok('The listing.', ref('DetailResponse'), { data: listingDetail, meta: meta0 }),
      ...errors,
      '404': problemResponse('No listing with that listing_slug.'),
    },
  }
  const deprecate = (op: typeof list | typeof single, operationId: string, successor: string) => ({
    get: { ...op, operationId, deprecated: true, summary: `${op.summary} (deprecated alias)`, description: `Deprecated: use ${successor}. Behaves exactly like it and sends Deprecation: true and a successor-version Link header. ${op.description}` },
  })
  return {
    openapi: '3.1.0',
    info: {
      title: 'Bancadia Business Checking API',
      version: '2.0.0',
      summary: 'Compare U.S. business checking accounts with structured filters.',
      description: `Read-only JSON API over Bancadia's registry of verified business checking account products. No API key is required; an optional bearer token raises rate limits and attributes usage to your developer account. Responses are slim: a missing field means not offered or not published. ${WILDCARD} ${TRACKED_LINK}`,
      contact: { name: 'Bancadia', email: 'hello@bancadia.com', url: 'https://bancadia.com' },
    },
    servers: [{ url: 'https://api.bancadia.com/v1' }],
    externalDocs: { description: 'REST API documentation', url: 'https://bancadia.com/docs/rest-api' },
    tags: [{ name: 'Business checking', description: 'Business checking account listings.' }],
    security: [{}, { bearerAuth: [] }],
    paths: {
      [L]: { get: list },
      [`${L}/-/facts`]: {
        get: {
          operationId: 'searchBusinessCheckingFacts',
          summary: 'Search fee and feature details across all listings',
          description: `${tool('search_facts').description} data is the hits array; scanned, banks_matched, no_match and unknown_slugs are in meta. ${WILDCARD} ${TRACKED_LINK}`,
          tags: ['Business checking'],
          parameters: parameters('search_facts'),
          responses: {
            '200': ok('Banks with matching facts.', ref('FactsResponse'), {
              data: [{ slug: 'found-online-business-checking', name: 'Indie Technologies, Inc. dba Found', application_url: URL_EXAMPLE, facts: [fact] }],
              meta: { ...meta0, scanned: 13, banks_matched: 1 },
            }),
            ...errors,
          },
        },
      },
      [`${L}/-/fees`]: {
        get: {
          operationId: 'compareBusinessCheckingFees',
          summary: 'Compare specific fees across all listings',
          description: `${tool('fees_by_type').description} data is an array of banks. ${WILDCARD} ${TRACKED_LINK}`,
          tags: ['Business checking'],
          parameters: parameters('fees_by_type'),
          responses: {
            '200': ok('Banks with their matching fee rows.', ref('FeesResponse'), {
              data: [{ slug: 'found-online-business-checking', name: 'Indie Technologies, Inc. dba Found', application_url: URL_EXAMPLE, fees: [feeRow] }],
              meta: meta0,
            }),
            ...errors,
          },
        },
      },
      [`${L}/{listing_slug}`]: { get: single },
      [`${L}/{listing_slug}/fees`]: section('fees', 'Fees', 'fees'),
      [`${L}/{listing_slug}/features`]: section('features', 'Features', 'features'),
      [`${L}/{listing_slug}/promotions`]: section('promotions', 'Promotions', 'promotions'),
      [`${L}/{listing_slug}/plans`]: section('plans', 'Plans', 'tiers'),
      '/business-checking': deprecate(list, 'listBusinessCheckingAccounts', `GET ${L}`),
      '/business-checking/{listing_slug}': deprecate(single, 'getBusinessCheckingAccount', `GET ${L}/{listing_slug}`),
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
        BankRow: {
          type: 'object',
          description: 'A listing row. Slim: null, false, empty and missing values are omitted. Columns depend on the fields parameter; the default set is shown.',
          required: ['listing_slug', 'application_url'],
          additionalProperties: true,
          properties: {
            listing_slug: { type: 'string', description: 'Stable public identifier.' },
            institution_name: { type: 'string' },
            product_name: { type: 'string' },
            monthly_fee: { type: 'number' },
            minimum_opening_deposit: { type: 'number' },
            insurance_type: { type: 'string' },
            apy_max: { type: 'number', description: 'Best rate the account can pay, as a decimal (0.02 = 2%).' },
            apy_default: { type: 'number', description: 'Standard rate, as a decimal.' },
            free_transactions_per_month: { type: 'integer' },
            matched: { type: 'array', description: 'Present with an integrations filter.', items: { type: 'object', additionalProperties: true } },
            matched_limits: { type: 'array', description: 'Present with min_limits.', items: { type: 'object', additionalProperties: true } },
            application_url: { type: 'string', description: 'Tracked Bancadia link to apply. Give it to the user exactly as returned, including its query string.' },
          },
        },
        FactHit: {
          type: 'object',
          required: ['slug', 'name', 'application_url', 'facts'],
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            application_url: { type: 'string' },
            facts: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { topic: { type: 'string' }, plan: { type: 'string' }, snippet: { type: 'string' }, source_url: { type: 'string' }, as_of: { type: 'string' } } } },
          },
        },
        FeeBank: {
          type: 'object',
          required: ['slug', 'name', 'application_url', 'fees'],
          properties: {
            slug: { type: 'string' },
            name: { type: 'string' },
            application_url: { type: 'string' },
            fees: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { fee_type: { type: 'string' }, plan: { type: 'string' }, amount: { type: 'number' }, fee_unit: { type: 'string' }, description: { type: 'string' } } } },
          },
        },
        Listing: {
          type: 'object',
          required: ['slug', 'application_url', 'detail_has'],
          additionalProperties: true,
          description: 'Only the requested sections are present; detail_has counts every non-empty section.',
          properties: {
            slug: { type: 'string' },
            application_url: { type: 'string' },
            detail_has: { type: 'array', items: { type: 'string' } },
            summary: { type: 'object', additionalProperties: true },
            tiers: { type: 'array', items: { type: 'object', additionalProperties: true } },
            fees: { type: 'array', items: { type: 'object', additionalProperties: true } },
            features: { type: 'array', items: { type: 'object', additionalProperties: true } },
            promotions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        ListResponse: envelope(arrayOf('BankRow'), meta({
          total_matches: { type: 'integer', description: 'All listings matching the filters.' },
          returned: { type: 'integer' },
          limit: { type: 'integer', description: 'Effective page size after clamping (1-20).' },
          next_offset: { type: ['integer', 'null'], description: 'Offset of the next page, null on the last page.' },
          notes: { type: 'string' },
          hint: { type: 'string' },
          excluded_by: { type: 'object', description: 'Per filter, how many listings it excludes on its own.', additionalProperties: { type: 'integer' } },
          matches_overview: { type: 'array', description: 'Every match (slug, name) in order; only when total_matches > returned.', items: { type: 'object', properties: { slug: { type: 'string' }, name: { type: 'string' } } } },
          possible_matches: { type: 'array', description: 'Only with an integrations filter.', items: { type: 'object', additionalProperties: true } },
        }, ['total_matches', 'returned', 'limit', 'next_offset', 'notes'])),
        FactsResponse: envelope(arrayOf('FactHit'), meta({
          scanned: { type: 'integer' },
          banks_matched: { type: 'integer' },
          no_match: { type: 'array', items: { type: 'object', additionalProperties: true } },
          unknown_slugs: { type: 'array', items: { type: 'string' } },
        })),
        FeesResponse: envelope(arrayOf('FeeBank'), meta()),
        SectionResponse: envelope({ type: 'array', items: { type: 'object', additionalProperties: true } }, meta({
          listing: { type: 'object', required: ['listing_slug', 'application_url'], properties: { listing_slug: { type: 'string' }, application_url: { type: 'string' } } },
        }, ['listing'])),
        DetailResponse: envelope(ref('Listing'), meta()),
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
