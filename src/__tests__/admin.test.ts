import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))

const limitMock = vi.hoisted(() => vi.fn())
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: limitMock }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

vi.mock('../lib/supabase', () => ({ createSupabaseClient: vi.fn() }))

import app from '../index'
import { createSupabaseClient } from '../lib/supabase'

const LISTING = '11111111-1111-4111-8111-111111111111'
const ROW = '22222222-2222-4222-8222-222222222222'
const FEATURE = '33333333-3333-4333-8333-333333333333'
const ADMIN_USER = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.com' }
const TOKEN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

type Result = { data: unknown; error: { message: string; code?: string } | null }
const done = (data: unknown = null, error: Result['error'] = null): Result => ({ data, error })

// A thenable query-builder stub: every call returns itself; awaiting or maybeSingle() yields the table's result.
function chain(result: Result) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order', 'update', 'is']) c[m] = vi.fn(() => c)
  c.maybeSingle = vi.fn().mockResolvedValue(result)
  c.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej)
  return c
}

type Setup = {
  user?: { id: string; email: string } | null // what auth.getUser resolves to (null = invalid JWT)
  isAdmin?: boolean
  token?: Record<string, unknown> | null // admin_api_tokens row
  tables?: Record<string, Result>
  rpc?: Result
}
function setup(o: Setup = {}) {
  const { user = ADMIN_USER, isAdmin = true, token = null, tables = {}, rpc = done({}) } = o
  const getUser = vi.fn().mockResolvedValue(user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } })
  const rpcFn = vi.fn().mockResolvedValue(rpc)
  const from = vi.fn((table: string) => {
    if (table === 'admin_users') return chain(done(isAdmin ? { user_id: ADMIN_USER.id } : null))
    if (table === 'admin_api_tokens') return chain(done(token))
    return chain(tables[table] ?? done(null))
  })
  vi.mocked(createSupabaseClient).mockReturnValue({ auth: { getUser }, from, rpc: rpcFn } as never)
  return { getUser, rpc: rpcFn, from }
}

async function call(path: string, init: RequestInit & { auth?: string | null } = {}) {
  const { auth = 'Bearer jwt-token', headers, ...rest } = init
  const h = new Headers(headers)
  if (auth) h.set('Authorization', auth)
  h.set('CF-Connecting-IP', '1.2.3.4')
  if (rest.body) h.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`http://localhost/v1/listings${path}`, { ...rest, headers: h }), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
const json = (v: unknown) => JSON.stringify(v)

beforeEach(() => {
  vi.clearAllMocks()
  limitMock.mockResolvedValue({ success: true, limit: 60, remaining: 59, reset: Date.now() + 30_000 })
})

describe('authentication', () => {
  it('401 problem+json, no-store, when there is no credential (and no DB call)', async () => {
    const m = setup()
    const res = await call('', { auth: null })
    expect(res.status).toBe(401)
    expect(res.headers.get('Content-Type')).toContain('application/problem+json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(m.getUser).not.toHaveBeenCalled()
  })

  it('401 for an invalid Supabase JWT', async () => {
    setup({ user: null })
    expect((await call('')).status).toBe(401)
  })

  it('403 for a valid Supabase user that is not an admin', async () => {
    setup({ isAdmin: false })
    expect((await call('')).status).toBe(403)
  })

  it('200 for an admin user', async () => {
    setup({
      tables: {
        business_deposit_accounts: done([
          { id: LISTING, listing_slug: 'a-b', product_name: 'A', listing_status: 'active', last_modified: 'x', institutions: { name: 'A', display_name: null } },
        ]),
      },
    })
    const res = await call('')
    expect(res.status).toBe(200)
    const body = await res.json<{ data: Record<string, unknown>[] }>()
    expect(body.data[0]).toMatchObject({ id: LISTING, product_name: 'A', institution: { name: 'A' } })
    expect(body.data[0]).not.toHaveProperty('institutions')
  })

  it.each([
    ['revoked', { id: TOKEN_ID, name: 'v', scope: 'write', expires_at: null, revoked_at: '2026-01-01T00:00:00Z' }],
    ['expired', { id: TOKEN_ID, name: 'v', scope: 'write', expires_at: '2020-01-01T00:00:00Z', revoked_at: null }],
    ['unknown', null],
  ])('401 for a %s admin token', async (_n, token) => {
    setup({ token })
    expect((await call('', { auth: 'Bearer sk_admin_abc' })).status).toBe(401)
  })

  it('a read-scope token can GET but cannot write', async () => {
    setup({ token: { id: TOKEN_ID, name: 'v', scope: 'read', expires_at: null, revoked_at: null }, tables: { business_deposit_accounts: done([]) } })
    expect((await call('', { auth: 'Bearer sk_admin_abc' })).status).toBe(200)
    const w = await call(`/${LISTING}/pause`, { method: 'POST', auth: 'Bearer sk_admin_abc' })
    expect(w.status).toBe(403)
  })

  it('a write-scope token acts as token:<name> in the audit trail', async () => {
    const m = setup({ token: { id: TOKEN_ID, name: 'validator', scope: 'write', expires_at: null, revoked_at: null }, rpc: done({ id: ROW, description: 'd', tsv: "'x'" }) })
    const res = await call(`/${LISTING}/fees`, { method: 'POST', auth: 'Bearer sk_admin_abc', body: json({ fee_type: 'other', description: 'd' }) })
    expect(res.status).toBe(201)
    expect(m.rpc).toHaveBeenCalledWith('admin_mutate', expect.objectContaining({ p_actor_id: TOKEN_ID, p_actor_label: 'token:validator', p_op: 'create', p_table: 'business_deposit_fees', p_listing_id: LISTING }))
    const body = await res.json<{ data: Record<string, unknown> }>()
    expect(body.data).toEqual({ id: ROW, description: 'd' }) // tsv never leaves the API
  })

  it('429 before authenticating when the IP bucket is exhausted', async () => {
    const m = setup()
    limitMock.mockResolvedValueOnce({ success: false, limit: 60, remaining: 0, reset: Date.now() + 12_000 })
    const res = await call('')
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(m.getUser).not.toHaveBeenCalled()
  })
})

describe('CORS', () => {
  it('answers the preflight for an allowed origin with PUT/DELETE and Authorization', async () => {
    setup()
    const origin = env.ALLOWED_ORIGINS!.split(',')[0]!.trim()
    const res = await call(`/${LISTING}/fees/${ROW}`, {
      method: 'OPTIONS', auth: null,
      headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE')
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization')
  })

  it('sends no CORS grant to an unlisted origin and never a wildcard', async () => {
    setup()
    const res = await call('', { headers: { Origin: 'https://evil.example' } })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('validation', () => {
  it('400 for a non-UUID listing id, 400 for malformed JSON', async () => {
    setup()
    expect((await call('/not-a-uuid')).status).toBe(400)
    expect((await call(`/${LISTING}/fees`, { method: 'POST', body: '{nope' })).status).toBe(400)
  })

  it.each([
    ['unknown key', { fee_type: 'other', description: 'd', bogus: 1 }],
    ['listing_id in the body', { fee_type: 'other', description: 'd', listing_id: ROW }],
    ['tsv in the body', { fee_type: 'other', description: 'd', tsv: 'x' }],
    ['missing required field', { fee_type: 'other' }],
    ['wrong type', { fee_type: 'other', description: 'd', amount: 'ten' }],
    ['bad check value', { fee_type: 'other', description: 'd', free_allowance_unit: 'eur' }],
  ])('422 for %s, and nothing is written', async (_n, payload) => {
    const m = setup()
    const res = await call(`/${LISTING}/fees`, { method: 'POST', body: json(payload) })
    expect(res.status).toBe(422)
    expect(m.rpc).not.toHaveBeenCalled()
  })

  it('PUT is a partial update: an empty object is accepted, unknown keys are not', async () => {
    const m = setup({ rpc: done({ id: ROW }) })
    expect((await call(`/${LISTING}/fees/${ROW}`, { method: 'PUT', body: json({}) })).status).toBe(200)
    expect((await call(`/${LISTING}/fees/${ROW}`, { method: 'PUT', body: json({ id: ROW }) })).status).toBe(422)
    expect(m.rpc).toHaveBeenCalledTimes(1)
  })

  it('details: protected columns are rejected before the database', async () => {
    const m = setup()
    for (const account of [{ listing_status: 'draft' }, { listing_slug: 'x' }, { tracker_url: 'https://t' }, { is_affiliate_tracked: true }]) {
      expect((await call(`/${LISTING}/details`, { method: 'PUT', body: json({ account }) })).status).toBe(422)
    }
    expect(m.rpc).not.toHaveBeenCalled()
  })

  it('details: both tables go to admin_update_details, and affiliate columns are stripped from the reply', async () => {
    const m = setup({
      rpc: done({
        business_deposit_accounts: { id: LISTING, product_name: 'N', tracker_url: 'https://secret', is_affiliate_tracked: true },
        business_checking_details: { listing_id: LISTING, rtp_supported: true },
      }),
    })
    const res = await call(`/${LISTING}/details`, { method: 'PUT', body: json({ account: { product_name: 'N' }, checking: { rtp_supported: true } }) })
    expect(res.status).toBe(200)
    expect(m.rpc).toHaveBeenCalledWith('admin_update_details', expect.objectContaining({ p_accounts: { product_name: 'N' }, p_details: { rtp_supported: true } }))
    const text = await res.text()
    expect(text).not.toContain('tracker_url')
    expect(text).not.toContain('is_affiliate_tracked')
  })
})

describe('database errors', () => {
  it.each([
    ['P0002', 404], ['22P02', 422], ['22023', 422], ['23505', 409], ['23503', 422], ['23502', 422],
  ])('maps SQLSTATE %s to %i', async (code, status) => {
    setup({ rpc: done(null, { message: 'db says no', code }) })
    const res = await call(`/${LISTING}/fees/${ROW}`, { method: 'PUT', body: json({ amount: 1 }) })
    expect(res.status).toBe(status)
    expect((await res.json<{ detail: string }>()).detail).toBe('db says no')
  })

  it('an unexpected error becomes a fixed 500 that leaks nothing', async () => {
    setup({ rpc: done(null, { message: 'relation "secret_table" does not exist', code: '42P01' }) })
    const res = await call(`/${LISTING}/fees/${ROW}`, { method: 'DELETE' })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret_table')
  })
})

describe('reads', () => {
  it('GET one row of another listing is a 404', async () => {
    setup({ tables: { business_deposit_fees: done(null) } })
    expect((await call(`/${LISTING}/fees/${ROW}`)).status).toBe(404)
  })

  it('GET /{id} for a missing listing is a 404', async () => {
    setup({ tables: { business_deposit_accounts: done(null) } })
    expect((await call(`/${LISTING}`)).status).toBe(404)
  })

  it('GET /{id} assembles every section and drops affiliate columns', async () => {
    setup({
      tables: {
        business_deposit_accounts: done({
          id: LISTING, listing_slug: 's', product_name: 'P', tracker_url: 'https://secret', is_affiliate_tracked: true,
          institutions: { name: 'I', display_name: null },
          business_checking_details: { listing_id: LISTING, rtp_supported: true },
          business_deposit_fees: [{ id: 'f2', created_at: '2' }, { id: 'f1', created_at: '1' }],
          business_deposit_account_features: [{ id: 'x', sort_order: null, created_at: '1', business_deposit_feature_integrations: [] }],
          business_deposit_plan_tiers: [], business_deposit_promotions: [], business_deposit_account_target_segments: [],
        }),
      },
    })
    const res = await call(`/${LISTING}`)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain('tracker_url')
    expect(text).not.toContain('is_affiliate_tracked')
    const { data } = JSON.parse(text) as { data: Record<string, any> }
    expect(Object.keys(data).sort()).toEqual(['account', 'checking', 'features', 'fees', 'plan_tiers', 'promotions', 'target_segments'])
    expect(data.fees.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2'])
    expect(data.account.institution).toEqual({ name: 'I', display_name: null })
  })

  it('an unknown path stays inside the admin app (no public caching headers)', async () => {
    setup()
    const res = await call(`/${LISTING}/nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('integrations, status and enums', () => {
  it('integration delete addresses the row as <feature_id>/<slug>; an encoded slash is refused', async () => {
    const m = setup({ rpc: done({ feature_id: FEATURE, integration_slug: 'quickbooks' }) })
    expect((await call(`/${LISTING}/features/${FEATURE}/integrations/quickbooks`, { method: 'DELETE' })).status).toBe(200)
    expect(m.rpc).toHaveBeenCalledWith('admin_mutate', expect.objectContaining({ p_op: 'delete', p_row_id: `${FEATURE}/quickbooks`, p_table: 'business_deposit_feature_integrations' }))
    expect((await call(`/${LISTING}/features/${FEATURE}/integrations/a%2Fb`, { method: 'DELETE' })).status).toBe(400)
  })

  it('integration create takes feature_id from the path, never the body', async () => {
    const m = setup({ rpc: done({ feature_id: FEATURE, integration_slug: 'xero' }) })
    expect((await call(`/${LISTING}/features/${FEATURE}/integrations`, { method: 'POST', body: json({ integration_slug: 'xero', feature_id: ROW }) })).status).toBe(422)
    expect((await call(`/${LISTING}/features/${FEATURE}/integrations`, { method: 'POST', body: json({ integration_slug: 'xero' }) })).status).toBe(201)
    expect(m.rpc).toHaveBeenCalledWith('admin_mutate', expect.objectContaining({ p_payload: { integration_slug: 'xero', feature_id: FEATURE } }))
  })

  it('pause and resume call admin_set_status with the matching status', async () => {
    const m = setup({ rpc: done({ id: LISTING, listing_status: 'paused' }) })
    expect((await call(`/${LISTING}/pause`, { method: 'POST' })).status).toBe(200)
    expect(m.rpc).toHaveBeenLastCalledWith('admin_set_status', expect.objectContaining({ p_status: 'paused', p_actor_label: ADMIN_USER.email }))
    await call(`/${LISTING}/resume`, { method: 'POST' })
    expect(m.rpc).toHaveBeenLastCalledWith('admin_set_status', expect.objectContaining({ p_status: 'active' }))
  })

  it('enums: unknown resource 404, bad value 422, good value 201', async () => {
    const m = setup({ rpc: done(['a', 'zz']) })
    expect((await call('/enums/nope')).status).toBe(404)
    expect((await call('/enums/fees/fee_type', { method: 'POST', body: json({ value: 'Bad Value' }) })).status).toBe(422)
    const ok = await call('/enums/fees/fee_type', { method: 'POST', body: json({ value: 'wire_swift' }) })
    expect(ok.status).toBe(201)
    expect(m.rpc).toHaveBeenLastCalledWith('admin_add_enum_value', { p_resource: 'fees', p_field: 'fee_type', p_value: 'wire_swift' })
  })

  it('enums are read per resource, so the fees form never sees every enum', async () => {
    const m = setup({ rpc: done({ fee_type: ['other'], fee_unit: ['flat'], amount_status: ['set'] }) })
    const res = await call('/enums/fees')
    expect(res.status).toBe(200)
    expect(m.rpc).toHaveBeenCalledWith('admin_field_enums', { p_resource: 'fees' })
  })
})
