import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn(),
}))

vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return {
      limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }),
    }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

import app from '../../index'
import { TOOLS } from '../../lib/tools'
import { mockRedis, withSession } from '../helpers'
import { KNOWN_SLUGS, APY_EXPECTED } from './fixtures'
import { realSupabase } from './db-helpers'

// Contract + oracle tests for query_business_checking and
// get_business_checking_listing against the real local Supabase.
//
// The "oracle" is the raw tables, read with flat per-table selects and joined
// in JS (loadRaw below) -- deliberately NOT via the handler's nested embeds,
// so a mistake in the handler's select string, join hints, column mapping or
// sorting can't also be baked into the expected values. Expected values are
// derived from whatever is in the DB, so they don't go stale when
// bancadia-db's seed data changes; the only hard-coded data is the Bluevine
// golden below and the tests' non-vacuity guards.

// Rows come straight from Supabase; typing every table's Row here would just
// restate database.types.ts.
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const SESSION_ID = crypto.randomUUID()

function post(body: object) {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk_test_token',
      ...withSession({ 'Mcp-Session-Id': SESSION_ID }),
    },
    body: JSON.stringify(body),
  })
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Row[]> {
  const request = post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const ctx = createExecutionContext()
  const response = await app.fetch(request, env, ctx)
  await waitOnExecutionContext(ctx)
  const body = await response.json<{ result: { content: Array<{ text: string }> } }>()
  return JSON.parse(body.result.content[0].text)
}

const query = (args: Record<string, unknown> = {}) => callTool('query_business_checking', args)
const getListing = (slug: string) => callTool('get_business_checking_listing', { listing_slug: slug })

// ---------------------------------------------------------------------------
// Oracle: raw tables, flat-selected and joined in JS.
// ---------------------------------------------------------------------------

type Raw = {
  accounts: Row[] // active checking listings in baseline order (monthly_fee asc, id asc)
  details: Map<string, Row>
  institutions: Map<string, Row>
  tiers: Map<string, Row[]>
  promos: Map<string, Row[]>
  fees: Map<string, Row[]>
  features: Map<string, Row[]>
}

function groupBy(rows: Row[], key: string) {
  const map = new Map<string, Row[]>()
  for (const r of rows) map.set(r[key], [...(map.get(r[key]) ?? []), r])
  return map
}

async function selectAll(table: string): Promise<Row[]> {
  const { data, error } = await (realSupabase() as any).from(table).select('*') // eslint-disable-line @typescript-eslint/no-explicit-any
  if (error) throw new Error(`oracle read of ${table} failed: ${error.message}`)
  return data
}

async function loadRaw(): Promise<Raw> {
  const [accounts, details, institutions, tiers, promos, fees, features] = await Promise.all([
    selectAll('business_deposit_accounts'),
    selectAll('business_checking_details'),
    selectAll('institutions'),
    selectAll('business_deposit_plan_tiers'),
    selectAll('business_deposit_promotions'),
    selectAll('business_deposit_fees'),
    selectAll('business_deposit_account_features'),
  ])
  return {
    accounts: accounts
      .filter((a) => a.listing_status === 'active' && a.product_type === 'checking')
      // Postgres orders uuids bytewise, which for lowercase hex text equals
      // plain string order.
      .sort((a, b) => Number(a.monthly_fee) - Number(b.monthly_fee) || (a.id < b.id ? -1 : 1)),
    details: new Map(details.map((d) => [d.listing_id, d])),
    institutions: new Map(institutions.map((i) => [i.id, i])),
    tiers: groupBy(tiers, 'listing_id'),
    promos: groupBy(promos, 'listing_id'),
    fees: groupBy(fees, 'listing_id'),
    features: groupBy(features, 'listing_id'),
  }
}

// Every attribute query_business_checking must return for one listing,
// spelled out key by key from the raw rows. Keep this in step with the tool's
// documented response shape (openapi.yaml), NOT with mapBusinessCheckingRow.
function expectedRow(raw: Raw, a: Row, segments: Row[] = []): Row {
  const d = raw.details.get(a.id)
  const g = (col: string) => d?.[col] ?? null
  const inst = raw.institutions.get(a.institution_id)
  return {
    listing_slug: a.listing_slug,
    institution_name: inst?.name ?? null,
    institution: inst
      ? {
          display_name: inst.display_name,
          website_url: inst.website_url,
          logo_url: inst.logo_url,
          institution_type: inst.institution_type,
          support_email: inst.support_email,
        }
      : null,
    product_name: a.product_name,
    monthly_fee: a.monthly_fee,
    monthly_fee_waiver_condition: a.monthly_fee_waiver_condition,
    minimum_opening_deposit: a.minimum_opening_deposit,
    entity_types_accepted: a.entity_types_accepted,
    available_states: a.available_states,
    target_industries: segments.filter((s) => s.category === 'industry_vertical').map((s) => s.segment),
    target_business_profiles: segments.filter((s) => s.category === 'business_profile').map((s) => s.segment),
    insurance_type: a.insurance_type,
    free_transactions_per_month: g('free_transactions_per_month'),
    cash_deposit_available: g('cash_deposit_available'),
    cash_deposit_fee_per_100: g('cash_deposit_fee_per_100'),
    monthly_cash_deposit_limit: g('monthly_cash_deposit_limit'),
    sub_accounts_supported: g('sub_accounts_supported'),
    rtp_supported: g('rtp_supported'),
    rtp_network: g('rtp_network'),
    accounting_integration_available: g('accounting_integration_available'),
    tax_integration_available: g('tax_integration_available'),
    expense_integration_available: g('expense_integration_available'),
    interest_bearing: g('interest_bearing'),
    apy_max: g('apy_max'),
    apy_default: g('apy_default'),
    apy_tiers: g('apy_tiers'),
    outgoing_domestic_wire_fee: g('outgoing_domestic_wire_fee'),
    incoming_domestic_wire_fee: g('incoming_domestic_wire_fee'),
    outgoing_international_wire_fee: g('outgoing_international_wire_fee'),
    incoming_international_wire_fee: g('incoming_international_wire_fee'),
    multicurrency_support: g('multicurrency_support'),
    free_domestic_wires_per_month: g('free_domestic_wires_per_month'),
    per_transaction_fee_after_limit: g('per_transaction_fee_after_limit'),
    atm_fee_reimbursement: g('atm_fee_reimbursement'),
    atm_fee_reimbursement_limit: g('atm_fee_reimbursement_limit'),
    atm_network: g('atm_network'),
    overdraft_protection_available: g('overdraft_protection_available'),
    overdraft_line_of_credit_available: g('overdraft_line_of_credit_available'),
    daily_debit_limit: g('daily_debit_limit'),
    ach_debit_block_available: g('ach_debit_block_available'),
    positive_pay_available: g('positive_pay_available'),
    remote_deposit_capture: g('remote_deposit_capture'),
    bill_pay_available: g('bill_pay_available'),
    check_writing_available: g('check_writing_available'),
    corporate_card_available: g('corporate_card_available'),
    virtual_cards_available: g('virtual_cards_available'),
    physical_debit_card_available: g('physical_debit_card_available'),
    plan_tiers: (raw.tiers.get(a.id) ?? []).map(expectedTier),
    promotions: (raw.promos.get(a.id) ?? []).map((p) => ({
      bonus_amount: p.bonus_amount,
      condition_description: p.condition_description,
      minimum_deposit: p.minimum_deposit,
      expiry_date: p.expiry_date,
      promo_url: p.promo_url,
    })),
    application_url: expectedApplicationUrl(a.application_url),
    last_modified: a.last_modified,
    is_verified: a.is_verified,
  }
}

// The router (index.ts) rewrites stored relative paths like '/go/x' into
// absolute URLs on the public host. Hard-coded here on purpose so changing the
// host is a deliberate, test-visible act.
function expectedApplicationUrl(stored: string | null): string | null {
  if (!stored) return stored
  if (/^https?:\/\//i.test(stored)) return stored
  return `https://bancadia.com${stored.startsWith('/') ? '' : '/'}${stored}`
}

function expectedTier(t: Row): Row {
  return {
    plan_name: t.plan_name,
    monthly_fee: t.monthly_fee,
    monthly_fee_waiver_condition: t.monthly_fee_waiver_condition,
    apy: t.apy, // plan tiers keep a plain `apy`; only business_checking_details was split
    apy_max_balance_eligible: t.apy_max_balance_eligible,
    apy_condition: t.apy_condition,
    is_default: t.is_default,
    sort_order: t.sort_order,
  }
}

const mapFee = (f: Row) => ({
  fee_type: f.fee_type,
  amount: f.amount,
  amount_description: f.amount_description,
  eligibility_criteria: f.eligibility_criteria,
  tiers: f.tiers,
  waivable: f.waivable,
  waiver_condition: f.waiver_condition,
})

const mapFeature = (f: Row) => ({ category: f.category, description: f.description, value: f.value })

// fee_types already exposed as flat columns on the listing (wire fees, cash
// deposit) -- the detail tool must not repeat them under general_fees/tier fees.
const FEE_TYPES_ON_FLAT_COLUMNS = new Set([
  'wire_domestic_outgoing',
  'wire_domestic_incoming',
  'wire_international_outgoing',
  'wire_international_incoming',
  'cash_deposit',
])

function expectedDetail(raw: Raw, a: Row): Row {
  const base = expectedRow(raw, a)
  const fees = (raw.fees.get(a.id) ?? []).filter((f) => !FEE_TYPES_ON_FLAT_COLUMNS.has(f.fee_type))
  const features = raw.features.get(a.id) ?? []
  const tiers = (raw.tiers.get(a.id) ?? []).slice().sort((x, y) => x.sort_order - y.sort_order)
  return {
    ...base,
    plan_tiers: tiers.map((t) => ({
      ...expectedTier(t),
      features: features.filter((f) => f.plan_tier_id === t.id).map(mapFeature),
      fees: fees.filter((f) => f.plan_tier_id === t.id).map(mapFee),
    })),
    general_fees: fees.filter((f) => f.plan_tier_id === null).map(mapFee),
    general_features: features.filter((f) => f.plan_tier_id === null).map(mapFeature),
  }
}

// The DB gives no ordering guarantee for embedded one-to-many rows, so
// comparisons treat these child arrays as multisets: sort canonically.
const canon = (v: unknown) => JSON.stringify(v)
const sortCanon = <T>(xs: T[]) => xs.slice().sort((a, b) => (canon(a) < canon(b) ? -1 : 1))
const bySortOrder = (a: Row, b: Row) => a.sort_order - b.sort_order

function normalizeQueryRow(row: Row): Row {
  return {
    ...row,
    plan_tiers: (row.plan_tiers as Row[]).slice().sort(bySortOrder),
    promotions: sortCanon(row.promotions as Row[]),
  }
}

function normalizeDetailRow(row: Row): Row {
  return {
    ...normalizeQueryRow(row),
    plan_tiers: (row.plan_tiers as Row[]).map((t) => ({
      ...t,
      features: sortCanon(t.features as Row[]),
      fees: sortCanon(t.fees as Row[]),
    })),
    general_fees: sortCanon(row.general_fees as Row[]),
    general_features: sortCanon(row.general_features as Row[]),
  }
}

let raw: Raw
let baselineSlugs: string[]

beforeAll(async () => {
  mockRedis({ tokenValid: true, tokenDeveloperId: null })
  raw = await loadRaw()
  baselineSlugs = raw.accounts.map((a) => a.listing_slug)
  if (raw.accounts.length < 10) {
    throw new Error(`Expected the onboarding-script seed data (13 checking listings), found ${raw.accounts.length} -- run \`npm run db:reset\`.`)
  }
})

// ---------------------------------------------------------------------------
// Schema contract for the apy -> apy_max/apy_default split.
// ---------------------------------------------------------------------------

describe('schema contract: business_checking_details apy split', () => {
  it('has apy_max and apy_default columns', async () => {
    const { error } = await realSupabase().from('business_checking_details').select('apy_max, apy_default').limit(1)
    expect(error).toBeNull()
  })

  it('no longer has the old apy column (a leftover reference would silently return [])', async () => {
    const { error } = await (realSupabase() as any).from('business_checking_details').select('apy').limit(1) // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(error).not.toBeNull()
  })

  it('leaves business_deposit_plan_tiers.apy untouched', async () => {
    const { error } = await realSupabase().from('business_deposit_plan_tiers').select('apy').limit(1)
    expect(error).toBeNull()
  })

  it('every seeded APY pair satisfies apy_default <= apy_max, and non-interest-bearing listings have neither', () => {
    for (const a of raw.accounts) {
      const d = raw.details.get(a.id)!
      if (d.interest_bearing) {
        expect(d.apy_max, a.listing_slug).not.toBeNull()
        expect(Number(d.apy_default ?? 0), a.listing_slug).toBeLessThanOrEqual(Number(d.apy_max))
      } else {
        expect(d.apy_max, a.listing_slug).toBeNull()
        expect(d.apy_default, a.listing_slug).toBeNull()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// query_business_checking: response shape.
// ---------------------------------------------------------------------------

const QUERY_KEYS = [
  'accounting_integration_available', 'ach_debit_block_available', 'application_url', 'apy_default', 'apy_max',
  'apy_tiers', 'atm_fee_reimbursement', 'atm_fee_reimbursement_limit', 'atm_network', 'available_states',
  'bill_pay_available', 'cash_deposit_available', 'cash_deposit_fee_per_100', 'check_writing_available',
  'corporate_card_available', 'daily_debit_limit', 'entity_types_accepted', 'expense_integration_available',
  'free_domestic_wires_per_month', 'free_transactions_per_month', 'incoming_domestic_wire_fee',
  'incoming_international_wire_fee', 'institution', 'institution_name', 'insurance_type', 'interest_bearing',
  'is_verified', 'last_modified', 'listing_slug', 'minimum_opening_deposit', 'monthly_cash_deposit_limit',
  'monthly_fee', 'monthly_fee_waiver_condition', 'multicurrency_support', 'outgoing_domestic_wire_fee',
  'outgoing_international_wire_fee', 'overdraft_line_of_credit_available', 'overdraft_protection_available',
  'per_transaction_fee_after_limit', 'physical_debit_card_available', 'plan_tiers', 'positive_pay_available',
  'product_name', 'promotions', 'remote_deposit_capture', 'rtp_network', 'rtp_supported', 'sub_accounts_supported',
  'target_business_profiles', 'target_industries', 'tax_integration_available', 'virtual_cards_available',
]
const INSTITUTION_KEYS = ['display_name', 'institution_type', 'logo_url', 'support_email', 'website_url']
const PLAN_TIER_KEYS = [
  'apy', 'apy_condition', 'apy_max_balance_eligible', 'is_default', 'monthly_fee', 'monthly_fee_waiver_condition',
  'plan_name', 'sort_order',
]
const PROMOTION_KEYS = ['bonus_amount', 'condition_description', 'expiry_date', 'minimum_deposit', 'promo_url']
const FEE_KEYS = ['amount', 'amount_description', 'eligibility_criteria', 'fee_type', 'tiers', 'waivable', 'waiver_condition']
const FEATURE_KEYS = ['category', 'description', 'value']

describe('query_business_checking: response contract', () => {
  it('every listing exposes exactly the documented keys (top level and nested), with no leaked columns', async () => {
    const results = await query()
    expect(results.length).toBe(raw.accounts.length)
    for (const row of results) {
      expect(Object.keys(row).sort(), row.listing_slug).toEqual(QUERY_KEYS)
      expect(Object.keys(row.institution).sort(), row.listing_slug).toEqual(INSTITUTION_KEYS)
      for (const t of row.plan_tiers) expect(Object.keys(t).sort()).toEqual(PLAN_TIER_KEYS)
      for (const p of row.promotions) expect(Object.keys(p).sort()).toEqual(PROMOTION_KEYS)
    }
    // Non-vacuity: at least one listing actually exercises each nested array.
    expect(results.some((r) => r.plan_tiers.length > 0)).toBe(true)
    expect(results.some((r) => r.promotions.length > 0)).toBe(true)
  })

  it('does not expose the removed flat `apy` field', async () => {
    for (const row of await query()) expect(row).not.toHaveProperty('apy')
  })

  it('returns every attribute of every listing exactly as stored (differential vs raw tables)', async () => {
    const results = await query()
    expect(results.map((r) => r.listing_slug)).toEqual(baselineSlugs)
    for (const a of raw.accounts) {
      const actual = results.find((r) => r.listing_slug === a.listing_slug)!
      expect(normalizeQueryRow(actual), a.listing_slug).toStrictEqual(normalizeQueryRow(expectedRow(raw, a)))
    }
  })

  it('returns listings in monthly_fee ascending order with id as the tiebreaker (exact order, not just stable)', async () => {
    const slugs = (await query()).map((r) => r.listing_slug)
    expect(slugs).toEqual(baselineSlugs)
  })

  it('excludes non-active listings (rho is unverified but still active; nothing inactive leaks)', async () => {
    const all = await selectAll('business_deposit_accounts')
    const inactive = all.filter((a) => a.listing_status !== 'active' || a.product_type !== 'checking').map((a) => a.listing_slug)
    const slugs = (await query()).map((r) => r.listing_slug)
    for (const s of inactive) expect(slugs).not.toContain(s)
  })
})

describe('query_business_checking: Bluevine golden record', () => {
  // Hard-coded on purpose: a literal snapshot of one rich listing (default
  // APY below max APY, three plan tiers, distinct wire fees). If bancadia-db's
  // onboarding script for Bluevine changes, update this deliberately.
  it('matches the expected literal response', async () => {
    const row = (await query()).find((r) => r.listing_slug === KNOWN_SLUGS.bluevine)!
    const { last_modified, ...rest } = normalizeQueryRow(row)
    expect(typeof last_modified).toBe('string') // changes on every db:reset
    expect(rest).toStrictEqual({
      listing_slug: 'bluevine-business-checking',
      institution_name: 'Bluevine Capital Inc.',
      institution: {
        display_name: 'Bluevine',
        website_url: 'https://www.bluevine.com/',
        logo_url: null,
        institution_type: 'fintech',
        support_email: null,
      },
      product_name: 'Bluevine Business Checking',
      monthly_fee: 0,
      monthly_fee_waiver_condition: null,
      minimum_opening_deposit: 0,
      entity_types_accepted: ['sole_prop', 'partnership', 'llc', 'c_corp', 's_corp'],
      available_states: ['ALL'],
      target_industries: [],
      target_business_profiles: [],
      insurance_type: 'fdic',
      free_transactions_per_month: null,
      cash_deposit_available: false,
      cash_deposit_fee_per_100: null,
      monthly_cash_deposit_limit: null,
      sub_accounts_supported: true,
      rtp_supported: false,
      rtp_network: null,
      accounting_integration_available: true,
      tax_integration_available: false,
      expense_integration_available: false,
      interest_bearing: true,
      apy_max: 0.03,
      apy_default: 0.013,
      apy_tiers: null,
      outgoing_domestic_wire_fee: 15,
      incoming_domestic_wire_fee: 0,
      outgoing_international_wire_fee: 25,
      incoming_international_wire_fee: 0,
      multicurrency_support: false,
      free_domestic_wires_per_month: null,
      per_transaction_fee_after_limit: null,
      atm_fee_reimbursement: false,
      atm_fee_reimbursement_limit: null,
      atm_network: 'MoneyPass',
      overdraft_protection_available: false,
      overdraft_line_of_credit_available: false,
      daily_debit_limit: null,
      ach_debit_block_available: true,
      positive_pay_available: true,
      remote_deposit_capture: true,
      bill_pay_available: true,
      check_writing_available: true,
      corporate_card_available: true,
      virtual_cards_available: true,
      physical_debit_card_available: true,
      plan_tiers: [
        {
          plan_name: 'Standard',
          monthly_fee: 0,
          monthly_fee_waiver_condition: null,
          apy: 0.013,
          apy_max_balance_eligible: 250000,
          apy_condition:
            'Spend $500/month on Bluevine Business Debit Mastercard OR receive $2,500/month in deposits to checking or sub-accounts',
          is_default: true,
          sort_order: 0,
        },
        {
          plan_name: 'Plus',
          monthly_fee: 30,
          monthly_fee_waiver_condition:
            'Waived each billing period by maintaining an average daily balance of at least $20,000 in Bluevine Business Checking and/or sub-accounts AND spending at least $2,000 on the Bluevine Business Debit Mastercard or Bluevine Business Cashback Mastercard.',
          apy: 0.0175,
          apy_max_balance_eligible: 250000,
          apy_condition: null,
          is_default: false,
          sort_order: 1,
        },
        {
          plan_name: 'Premier',
          monthly_fee: 95,
          monthly_fee_waiver_condition:
            'Waived each billing period by maintaining an average daily balance of at least $100,000 in Bluevine Business Checking and/or sub-accounts AND spending at least $5,000 on the Bluevine Business Debit Mastercard.',
          apy: 0.03,
          apy_max_balance_eligible: null,
          apy_condition: null,
          is_default: false,
          sort_order: 2,
        },
      ],
      promotions: [],
      application_url: 'https://bancadia.com/go/bluevine/business-checking',
      is_verified: true,
    })
  })

  it('exposes JSON apy_tiers when a listing has them (Grasshopper, Highbeam)', async () => {
    const results = await query()
    for (const slug of [KNOWN_SLUGS.grasshopper, 'highbeam-business-checking']) {
      const row = results.find((r) => r.listing_slug === slug)!
      expect(row.apy_tiers, slug).not.toBeNull()
      expect(row.apy_tiers, slug).toStrictEqual(raw.details.get(raw.accounts.find((a) => a.listing_slug === slug)!.id)!.apy_tiers)
    }
  })

  it.each(Object.entries(APY_EXPECTED))('%s reports its seeded apy_default/apy_max', async (slug, expected) => {
    const row = (await query()).find((r) => r.listing_slug === slug)!
    expect(row).toMatchObject(expected)
  })
})

// ---------------------------------------------------------------------------
// query_business_checking: every filter, checked against a predicate over the
// raw rows. Results must match the oracle's slug list exactly, in order.
// ---------------------------------------------------------------------------

type FilterCase = {
  name: string
  args: Record<string, unknown>
  keep: (a: Row, d: Row | undefined) => boolean
  // Set for cases whose seed data can't split the listing set (e.g. every
  // listing is fdic); everything else must both keep and drop something so a
  // no-op filter can't pass.
  degenerate?: 'keepsAll' | 'keepsNone'
}

const has = (v: unknown) => v !== null && v !== undefined

const FILTER_CASES: FilterCase[] = [
  { name: 'monthly_fee_max', args: { monthly_fee_max: 10 }, keep: (a) => Number(a.monthly_fee) <= 10 },
  { name: 'monthly_fee_max (inclusive at 15)', args: { monthly_fee_max: 15 }, keep: () => true, degenerate: 'keepsAll' },
  { name: 'minimum_opening_deposit_max', args: { minimum_opening_deposit_max: 0 }, keep: (a) => Number(a.minimum_opening_deposit) <= 0 },
  { name: 'insurance_type fdic', args: { insurance_type: 'fdic' }, keep: (a) => a.insurance_type === 'fdic', degenerate: 'keepsAll' },
  { name: 'insurance_type ncua', args: { insurance_type: 'ncua' }, keep: (a) => a.insurance_type === 'ncua', degenerate: 'keepsNone' },
  { name: 'cash_deposit_available true', args: { cash_deposit_available: true }, keep: (_a, d) => d?.cash_deposit_available === true },
  { name: 'cash_deposit_available false', args: { cash_deposit_available: false }, keep: (_a, d) => d?.cash_deposit_available === false },
  { name: 'sub_accounts_supported true', args: { sub_accounts_supported: true }, keep: (_a, d) => d?.sub_accounts_supported === true },
  { name: 'sub_accounts_supported false', args: { sub_accounts_supported: false }, keep: (_a, d) => d?.sub_accounts_supported === false },
  { name: 'rtp_supported true', args: { rtp_supported: true }, keep: (_a, d) => d?.rtp_supported === true },
  { name: 'rtp_supported false', args: { rtp_supported: false }, keep: (_a, d) => d?.rtp_supported === false },
  { name: 'rtp_network fednow', args: { rtp_network: 'fednow' }, keep: (_a, d) => d?.rtp_network === 'fednow' },
  { name: 'rtp_network both', args: { rtp_network: 'both' }, keep: (_a, d) => d?.rtp_network === 'both' },
  { name: 'accounting_integration_available true', args: { accounting_integration_available: true }, keep: (_a, d) => d?.accounting_integration_available === true },
  { name: 'accounting_integration_available false', args: { accounting_integration_available: false }, keep: (_a, d) => d?.accounting_integration_available === false },
  { name: 'tax_integration_available true', args: { tax_integration_available: true }, keep: (_a, d) => d?.tax_integration_available === true },
  { name: 'expense_integration_available true', args: { expense_integration_available: true }, keep: (_a, d) => d?.expense_integration_available === true },
  { name: 'interest_bearing true', args: { interest_bearing: true }, keep: (_a, d) => d?.interest_bearing === true },
  { name: 'interest_bearing false', args: { interest_bearing: false }, keep: (_a, d) => d?.interest_bearing === false },
  { name: 'free_transactions_min 20 (inclusive; NULL excluded)', args: { free_transactions_min: 20 }, keep: (_a, d) => has(d?.free_transactions_per_month) && d!.free_transactions_per_month >= 20 },
  { name: 'free_transactions_min 100', args: { free_transactions_min: 100 }, keep: (_a, d) => has(d?.free_transactions_per_month) && d!.free_transactions_per_month >= 100 },
  { name: 'apy_min 0.02 (inclusive, on apy_max)', args: { apy_min: 0.02 }, keep: (_a, d) => has(d?.apy_max) && Number(d!.apy_max) >= 0.02 },
  { name: 'apy_min 0.0175 (inclusive boundary)', args: { apy_min: 0.0175 }, keep: (_a, d) => has(d?.apy_max) && Number(d!.apy_max) >= 0.0175 },
  { name: 'apy_min 0.0001 (drops NULL apy_max)', args: { apy_min: 0.0001 }, keep: (_a, d) => has(d?.apy_max) && Number(d!.apy_max) >= 0.0001 },
  { name: 'apy_min above every rate', args: { apy_min: 0.5 }, keep: () => false, degenerate: 'keepsNone' },
  { name: 'entity_types_accepted nonprofit', args: { entity_types_accepted: ['nonprofit'] }, keep: (a) => (a.entity_types_accepted as string[]).includes('nonprofit') },
  { name: 'entity_types_accepted sole_prop+nonprofit (all required)', args: { entity_types_accepted: ['sole_prop', 'nonprofit'] }, keep: (a) => ['sole_prop', 'nonprofit'].every((t) => (a.entity_types_accepted as string[]).includes(t)) },
  { name: 'available_states CA (ALL is a wildcard)', args: { available_states: ['CA'] }, keep: (a) => (a.available_states as string[]).includes('ALL') || (a.available_states as string[]).includes('CA'), degenerate: 'keepsAll' },
  {
    name: 'combined: interest_bearing + apy_min + monthly_fee_max',
    args: { interest_bearing: true, apy_min: 0.02, monthly_fee_max: 0 },
    keep: (a, d) => d?.interest_bearing === true && has(d?.apy_max) && Number(d!.apy_max) >= 0.02 && Number(a.monthly_fee) <= 0,
  },
  {
    name: 'combined: details filter + in-memory filter (rtp_supported + entity_types_accepted)',
    args: { rtp_supported: true, entity_types_accepted: ['nonprofit'] },
    keep: (a, d) => d?.rtp_supported === true && (a.entity_types_accepted as string[]).includes('nonprofit'),
  },
  {
    name: 'combined: two details filters (sub_accounts_supported + expense_integration_available)',
    args: { sub_accounts_supported: true, expense_integration_available: true },
    keep: (_a, d) => d?.sub_accounts_supported === true && d?.expense_integration_available === true,
  },
]

describe('query_business_checking: filters vs raw-table oracle', () => {
  it.each(FILTER_CASES)('$name', async ({ args, keep, degenerate }) => {
    const expected = raw.accounts.filter((a) => keep(a, raw.details.get(a.id))).map((a) => a.listing_slug)
    const actual = (await query(args)).map((r) => r.listing_slug)

    expect(actual).toEqual(expected)

    if (degenerate === 'keepsAll') expect(expected.length).toBe(baselineSlugs.length)
    else if (degenerate === 'keepsNone') expect(expected.length).toBe(0)
    else {
      // Non-vacuity: the seed data must actually split on this filter.
      expect(expected.length, 'seed data no longer has any listing matching this filter').toBeGreaterThan(0)
      expect(expected.length, 'seed data no longer has any listing excluded by this filter').toBeLessThan(baselineSlugs.length)
    }
  })

  it('every input property advertised in tools/list has a filter case here (or the segment tests below)', () => {
    const schema = TOOLS.find((t) => t.name === 'query_business_checking')!.inputSchema as { properties: Record<string, unknown> }
    const advertised = Object.keys(schema.properties).sort()
    const covered = new Set([
      ...FILTER_CASES.flatMap((c) => Object.keys(c.args)),
      'target_industries',
      'target_business_profiles',
    ])
    expect(advertised.filter((p) => !covered.has(p)), 'tool schema property with no integration test').toEqual([])
    for (const p of covered) expect(advertised, `test filters on ${p} but tools.ts doesn't advertise it`).toContain(p)
  })

  it('ignores unknown extra args rather than erroring (handler tolerates them)', async () => {
    // additionalProperties:false is advisory to clients; the Worker itself
    // should still return the full list, not [] from a swallowed error.
    const slugs = (await query({ not_a_real_filter: 1 })).map((r) => r.listing_slug)
    expect(slugs).toEqual(baselineSlugs)
  })
})

// ---------------------------------------------------------------------------
// get_business_checking_listing: response shape.
// ---------------------------------------------------------------------------

describe('get_business_checking_listing: response contract', () => {
  it('exposes the query keys plus general_fees/general_features, with tier-level features/fees nested', async () => {
    for (const a of raw.accounts) {
      const [row] = await getListing(a.listing_slug)
      expect(Object.keys(row).sort(), a.listing_slug).toEqual([...QUERY_KEYS, 'general_features', 'general_fees'].sort())
      for (const t of row.plan_tiers) {
        expect(Object.keys(t).sort(), a.listing_slug).toEqual([...PLAN_TIER_KEYS, 'features', 'fees'].sort())
        for (const f of t.fees) expect(Object.keys(f).sort()).toEqual(FEE_KEYS)
        for (const f of t.features) expect(Object.keys(f).sort()).toEqual(FEATURE_KEYS)
      }
      for (const f of row.general_fees) expect(Object.keys(f).sort()).toEqual(FEE_KEYS)
      for (const f of row.general_features) expect(Object.keys(f).sort()).toEqual(FEATURE_KEYS)
    }
  })

  it('returns every attribute of every listing, including fees, features and tiers (differential vs raw tables)', async () => {
    for (const a of raw.accounts) {
      const results = await getListing(a.listing_slug)
      expect(results.length, a.listing_slug).toBe(1)
      expect(normalizeDetailRow(results[0]), a.listing_slug).toStrictEqual(normalizeDetailRow(expectedDetail(raw, a)))
    }
  })

  it('agrees with query_business_checking on every shared attribute', async () => {
    const list = await query()
    for (const row of list) {
      const [detail] = await getListing(row.listing_slug)
      const { general_fees, general_features, ...detailShared } = detail
      const detailTiersStripped = {
        ...detailShared,
        plan_tiers: (detail.plan_tiers as Row[]).map(({ features, fees, ...t }) => t),
      }
      expect(normalizeQueryRow(detailTiersStripped), row.listing_slug).toStrictEqual(normalizeQueryRow(row))
    }
  })

  it('never repeats fee types already surfaced as flat columns, and drops no other fee or feature', async () => {
    let sawCoveredFee = false
    for (const a of raw.accounts) {
      const rawFees = raw.fees.get(a.id) ?? []
      const covered = rawFees.filter((f) => FEE_TYPES_ON_FLAT_COLUMNS.has(f.fee_type))
      if (covered.length > 0) sawCoveredFee = true

      const [row] = await getListing(a.listing_slug)
      const outFees = [...row.general_fees, ...(row.plan_tiers as Row[]).flatMap((t) => t.fees)]
      const outFeatures = [...row.general_features, ...(row.plan_tiers as Row[]).flatMap((t) => t.features)]

      for (const f of outFees) expect(FEE_TYPES_ON_FLAT_COLUMNS.has(f.fee_type), `${a.listing_slug} repeats ${f.fee_type}`).toBe(false)
      // Every non-covered fee/feature lands in exactly one bucket.
      expect(outFees.length, `${a.listing_slug} fees`).toBe(rawFees.length - covered.length)
      expect(outFeatures.length, `${a.listing_slug} features`).toBe((raw.features.get(a.id) ?? []).length)
    }
    expect(sawCoveredFee, 'seed data no longer has a wire/cash-deposit fee to prove the exclusion').toBe(true)
  })

  it('orders plan_tiers by sort_order and features by sort_order (within general and within each tier)', async () => {
    let sawMultiTier = false
    for (const a of raw.accounts) {
      const [row] = await getListing(a.listing_slug)
      const tiers = (row.plan_tiers as Row[]).map((t) => t.sort_order)
      expect(tiers, a.listing_slug).toEqual(tiers.slice().sort((x, y) => x - y))
      if (tiers.length > 1) sawMultiTier = true

      const rawFeatures = raw.features.get(a.id) ?? []
      const check = (actual: Row[], rawSubset: Row[], label: string) => {
        // Group the raw rows by sort_order; actual must be those groups in order,
        // each group internally unordered (ties have no defined order).
        const groups = [...new Set(rawSubset.map((f) => f.sort_order))].sort((x, y) => x - y)
        let i = 0
        for (const so of groups) {
          const want = rawSubset.filter((f) => f.sort_order === so).map(mapFeature)
          const got = actual.slice(i, i + want.length)
          expect(sortCanon(got), `${a.listing_slug} ${label} sort_order ${so}`).toEqual(sortCanon(want))
          i += want.length
        }
      }
      check(row.general_features, rawFeatures.filter((f) => f.plan_tier_id === null), 'general_features')
      for (const t of raw.tiers.get(a.id) ?? []) {
        const out = (row.plan_tiers as Row[]).find((x) => x.plan_name === t.plan_name)!
        check(out.features, rawFeatures.filter((f) => f.plan_tier_id === t.id), `tier ${t.plan_name}`)
      }
    }
    expect(sawMultiTier).toBe(true)
  })

  it('returns [] for unknown, empty and non-string slugs (no error leak)', async () => {
    expect(await getListing('definitely-not-a-listing')).toEqual([])
    expect(await getListing('')).toEqual([])
    expect(await callTool('get_business_checking_listing', { listing_slug: 42 })).toEqual([])
    expect(await callTool('get_business_checking_listing', {})).toEqual([])
  })

  it('reports apy_default/apy_max for the single-listing view, including Found where default is 0', async () => {
    const [found] = await getListing(KNOWN_SLUGS.found)
    expect(found).toMatchObject({ apy_default: 0, apy_max: 0.025, interest_bearing: true })
    const [mercury] = await getListing(KNOWN_SLUGS.mercury)
    expect(mercury).toMatchObject({ apy_default: null, apy_max: null, interest_bearing: false })
  })
})

// ---------------------------------------------------------------------------
// Target-segment soft ranking. The seed data has no segment rows, so this
// inserts a few and always removes them again.
// ---------------------------------------------------------------------------

describe('query_business_checking: target segment ranking (inserts and removes its own rows)', () => {
  const db = () => realSupabase()
  let karatId: string
  let rampId: string

  const cleanup = async () => {
    await db().from('business_deposit_account_target_segments').delete().in('listing_id', [karatId, rampId])
  }

  beforeAll(async () => {
    karatId = raw.accounts.find((a) => a.listing_slug === 'karat-business-checking')!.id
    rampId = raw.accounts.find((a) => a.listing_slug === KNOWN_SLUGS.ramp)!.id
    await cleanup() // in case an earlier run died mid-test
    const { error } = await db()
      .from('business_deposit_account_target_segments')
      .insert([
        { listing_id: karatId, category: 'industry_vertical', segment: 'ecommerce' },
        { listing_id: karatId, category: 'business_profile', segment: 'early_stage_startup' },
        { listing_id: rampId, category: 'industry_vertical', segment: 'ecommerce' },
      ])
    expect(error).toBeNull()
  })

  afterAll(async () => {
    await cleanup()
  })

  // Independent restatement of the ranking rule: descending overlap count,
  // ties keep the baseline (monthly_fee, id) order, nothing is excluded.
  const rank = (scores: Record<string, number>) =>
    baselineSlugs
      .map((slug, i) => ({ slug, i }))
      .sort((a, b) => (scores[b.slug] ?? 0) - (scores[a.slug] ?? 0) || a.i - b.i)
      .map((x) => x.slug)

  it('ranks by overlap count across both facets and never excludes non-matching listings', async () => {
    const slugs = (await query({ target_industries: ['ecommerce'], target_business_profiles: ['early_stage_startup'] })).map((r) => r.listing_slug)
    expect(slugs).toEqual(rank({ 'karat-business-checking': 2, [KNOWN_SLUGS.ramp]: 1 }))
    expect(slugs.length).toBe(baselineSlugs.length)
  })

  it('breaks ties by baseline order', async () => {
    const slugs = (await query({ target_industries: ['ecommerce'] })).map((r) => r.listing_slug)
    expect(slugs).toEqual(rank({ 'karat-business-checking': 1, [KNOWN_SLUGS.ramp]: 1 }))
  })

  it('leaves order untouched when the requested segments match nothing', async () => {
    const slugs = (await query({ target_industries: ['agriculture'] })).map((r) => r.listing_slug)
    expect(slugs).toEqual(baselineSlugs)
  })

  it('buckets each listing\'s segments into target_industries / target_business_profiles', async () => {
    const results = await query()
    const karat = results.find((r) => r.listing_slug === 'karat-business-checking')!
    const ramp = results.find((r) => r.listing_slug === KNOWN_SLUGS.ramp)!
    const other = results.find((r) => r.listing_slug === KNOWN_SLUGS.mercury)!
    expect(karat).toMatchObject({ target_industries: ['ecommerce'], target_business_profiles: ['early_stage_startup'] })
    expect(ramp).toMatchObject({ target_industries: ['ecommerce'], target_business_profiles: [] })
    expect(other).toMatchObject({ target_industries: [], target_business_profiles: [] })
  })

  it('combines with a details filter (segments rank, apy_min restricts)', async () => {
    const slugs = (await query({ apy_min: 0.02, target_industries: ['ecommerce'] })).map((r) => r.listing_slug)
    const eligible = new Set(
      raw.accounts.filter((a) => has(raw.details.get(a.id)?.apy_max) && Number(raw.details.get(a.id)!.apy_max) >= 0.02).map((a) => a.listing_slug)
    )
    // Ramp (apy_max 0.02, tagged ecommerce) ranks first; karat (0.0175) is filtered out entirely.
    expect(new Set(slugs)).toEqual(eligible)
    expect(slugs[0]).toBe(KNOWN_SLUGS.ramp)
    expect(slugs).not.toContain('karat-business-checking')
  })
})
