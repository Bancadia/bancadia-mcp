import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }) }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})

// Real database, no Supabase mock. This suite also runs in CI against the hosted dev project, so:
//   * reads run everywhere, with a read-scope token whose secret is random per run, expires in 10 minutes and is
//     deleted afterwards (no credential is ever committed or left behind);
//   * writes run only against a local database, on a throwaway listing this file creates and deletes, so no real
//     listing's last_modified or audit trail is touched. (listing_audits is append-only: its rows stay.)

import app from '../../index'
import { sha256hex } from '../../lib/auth'
import { realSupabase } from './db-helpers'
import { ENUM_RESOURCES } from '../../admin/resources'
import { createClient } from '@supabase/supabase-js'

const LOCAL = ['127.0.0.1', 'localhost'].includes(new URL(env.SUPABASE_URL).hostname)
const db = realSupabase()
const rand = () => crypto.randomUUID().replaceAll('-', '')
const READ_TOKEN = `sk_admin_it_${rand()}`
const WRITE_TOKEN = `sk_admin_it_${rand()}`
const created: string[] = []

async function addToken(raw: string, scope: 'read' | 'write') {
  const { data, error } = await db
    .from('admin_api_tokens')
    .insert({
      name: `integration-test-${scope}`, token_prefix: raw.slice(0, 16), token_hash: await sha256hex(raw), scope,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    .select('id')
    .single()
  if (error) throw error
  created.push(data.id)
}

async function api(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = READ_TOKEN, ...rest } = init
  const headers = new Headers(rest.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (rest.body) headers.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`http://localhost/v1/listings${path}`, { ...rest, headers }), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}
const j = <T = any>(res: Response) => res.json<T>() // eslint-disable-line @typescript-eslint/no-explicit-any
const body = (v: unknown) => JSON.stringify(v)

beforeAll(async () => {
  await addToken(READ_TOKEN, 'read')
  if (LOCAL) await addToken(WRITE_TOKEN, 'write')
})
afterAll(async () => {
  if (created.length) await db.from('admin_api_tokens').delete().in('id', created)
})

describe('admin API reads (real schema: every selected column must exist)', () => {
  let listingId: string
  let featureId: string | undefined

  beforeAll(async () => {
    const { data } = await db
      .from('business_deposit_accounts').select('id, business_deposit_account_features(id)').limit(1).single()
    listingId = data!.id
    featureId = data!.business_deposit_account_features[0]?.id
  })

  it('rejects a missing credential and a read token that tries to write', async () => {
    expect((await api('', { token: null })).status).toBe(401)
    expect((await api(`/${listingId}/pause`, { method: 'POST' })).status).toBe(403)
  })

  it('lists listings with slug, product name and institution', async () => {
    const res = await api('')
    expect(res.status).toBe(200)
    const { data } = await j(res)
    expect(data.length).toBeGreaterThan(0)
    expect(data[0]).toMatchObject({ id: expect.any(String), listing_slug: expect.any(String), product_name: expect.any(String) })
    expect(data[0].institution).toBeTruthy()
    const one = await j(await api(`?slug=${data[0].listing_slug}`))
    expect(one.data).toHaveLength(1)
  })

  it('returns the whole listing, and never affiliate columns', async () => {
    const res = await api(`/${listingId}`)
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain('tracker_url')
    expect(text).not.toContain('is_affiliate_tracked')
    const { data } = JSON.parse(text)
    expect(Object.keys(data).sort()).toEqual(['account', 'checking', 'features', 'fees', 'plan_tiers', 'promotions', 'sources', 'target_segments'])
    expect(data.account.id).toBe(listingId)
    expect(data.account.institution.name).toBeTruthy()
    for (const f of data.features) expect(Array.isArray(f.business_deposit_feature_integrations)).toBe(true)
  })

  it.each(['fees', 'features', 'promotions', 'plan-tiers', 'target-segments', 'integrations', 'sources', 'details'])(
    'GET /{id}/%s works against the live columns',
    async (name) => {
      const res = await api(`/${listingId}/${name}`)
      expect(res.status, await res.clone().text()).toBe(200)
    }
  )

  it('reads a single row and 404s for a row of another listing', async () => {
    const list = await j(await api(`/${listingId}/features`))
    if (list.data.length) {
      expect((await api(`/${listingId}/features/${list.data[0].id}`)).status).toBe(200)
      const other = '99999999-9999-4999-8999-999999999999'
      expect((await api(`/${other}/features/${list.data[0].id}`)).status).toBe(404)
    }
    if (featureId) expect((await api(`/${listingId}/features/${featureId}/integrations`)).status).toBe(200)
  })

  it.each(ENUM_RESOURCES)('GET /enums/%s resolves the enum columns of that resource only', async (resource) => {
    const res = await api(`/enums/${resource}`)
    expect(res.status).toBe(200)
    const { data } = await j(res)
    if (resource === 'fees') expect(Object.keys(data).sort()).toEqual(['amount_status', 'fee_type', 'fee_unit'])
    if (resource === 'details') {
      expect(data).toHaveProperty('insurance_type')
      expect(data).toHaveProperty('entity_types_accepted')
      expect(data).not.toHaveProperty('listing_status')
    }
    if (resource === 'integrations') expect(data).toEqual({})
  })

  it('serves the integration vocabulary', async () => {
    const { data } = await j(await api('/vocab/integrations'))
    expect(data.length).toBeGreaterThan(0)
    expect(data[0]).toHaveProperty('slug')
  })
})

describe.runIf(LOCAL)('admin API writes (local database, throwaway listing)', () => {
  let id: string
  const slug = `it-admin-${rand().slice(0, 12)}`
  const actor = 'token:integration-test-write'

  beforeAll(async () => {
    const { data: inst } = await db.from('institutions').select('id').limit(1).single()
    const { data, error } = await db
      .from('business_deposit_accounts')
      .insert({
        institution_id: inst!.id, product_name: 'IT Admin', product_type: 'checking', application_url: `/go/it/${slug}`,
        insurance_type: 'fdic', entity_types_accepted: ['llc'], listing_slug: slug,
      })
      .select('id')
      .single()
    if (error) throw error
    id = data.id
  })
  afterAll(async () => {
    await db.from('business_deposit_accounts').delete().eq('id', id) // cascades to every child row
  })

  const w = (path: string, method: string, payload?: unknown) =>
    api(`/${id}${path}`, { method, token: WRITE_TOKEN, ...(payload === undefined ? {} : { body: body(payload) }) })
  const lastModified = async () =>
    (await db.from('business_deposit_accounts').select('last_modified').eq('id', id).single()).data!.last_modified
  const audits = async () =>
    (await db.from('listing_audits').select('action, actor_email, before_values, after_values').eq('listing_id', id)).data!

  it('fees: create, update, delete are atomic, audited with only the changed fields, and bump last_modified', async () => {
    await db.from('business_deposit_accounts').update({ last_modified: '2020-01-01T00:00:00Z' }).eq('id', id)
    const create = await w('/fees', 'POST', { fee_type: 'other', description: 'it fee', amount: 12.5 })
    expect(create.status, await create.clone().text()).toBe(201)
    const fee = (await j(create)).data
    expect(fee).not.toHaveProperty('tsv')
    expect(new Date(await lastModified()).getFullYear()).toBeGreaterThan(2020)

    const upd = await w(`/fees/${fee.id}`, 'PUT', { amount: 15 })
    expect(upd.status).toBe(200)
    const rows = await audits()
    const updated = rows.find((r) => r.action === 'updated')!
    expect(updated.actor_email).toBe(actor)
    expect((updated.before_values as any).fields).toEqual({ amount: 12.5 })
    expect((updated.after_values as any).fields).toEqual({ amount: 15 })

    expect((await w(`/fees/${fee.id}`, 'PUT', { fee_type: 'not_a_real_fee_type' })).status).toBe(422)
    expect((await w(`/fees/${fee.id}`, 'DELETE')).status).toBe(200)
    expect((await w(`/fees/${fee.id}`, 'DELETE')).status).toBe(404)
    expect((await audits()).map((r) => r.action).sort()).toEqual(['created', 'deleted', 'updated'])
  })

  it('features, promotions, plan tiers, target segments and integrations round-trip', async () => {
    const feature = (await j(await w('/features', 'POST', { category: 'other', description: 'it feature' }))).data
    const slugRow = (await db.from('integration_vocab').select('slug').limit(1).single()).data!
    const integ = await w(`/features/${feature.id}/integrations`, 'POST', { integration_slug: slugRow.slug, note: 'n1' })
    expect(integ.status, await integ.clone().text()).toBe(201)
    expect((await w(`/features/${feature.id}/integrations/${slugRow.slug}`, 'PUT', { note: 'n2', connection_method: 'native' })).status).toBe(200)
    expect((await j(await w(`/features/${feature.id}/integrations/${slugRow.slug}`, 'GET'))).data.note).toBe('n2')
    expect((await w(`/features/${feature.id}/integrations/${slugRow.slug}`, 'DELETE')).status).toBe(200)

    const promo = (await j(await w('/promotions', 'POST', { bonus_amount: 300, condition_description: 'it promo' }))).data
    expect((await w(`/promotions/${promo.id}`, 'PUT', { bonus_amount: 400 })).status).toBe(200)
    const tier = (await j(await w('/plan-tiers', 'POST', { plan_name: 'IT Plan', monthly_fee: 5 }))).data
    expect((await w(`/plan-tiers/${tier.id}`, 'PUT', { apy: 1.5 })).status).toBe(200)
    // a fee may point at this listing's own tier, never at another listing's
    const fee = (await j(await w('/fees', 'POST', { fee_type: 'other', description: 'tiered', plan_tier_id: tier.id }))).data
    expect((await w(`/fees/${fee.id}`, 'PUT', { plan_tier_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(422)
    const seg = (await j(await w('/target-segments', 'POST', { category: 'industry_vertical', segment: 'ecommerce' }))).data
    expect((await w('/target-segments', 'POST', { category: 'industry_vertical', segment: 'ecommerce' })).status).toBe(409)
    // watch sources: unique (listing, url), CHECK-constrained fetch_mode, deactivate then delete
    const src = (await j(await w('/sources', 'POST', { source_type: 'fee_schedule', url: 'https://example.com/it-fees.pdf', format: 'pdf', fetch_mode: 'manual' }))).data
    expect((await w('/sources', 'POST', { source_type: 'fee_schedule', url: 'https://example.com/it-fees.pdf' })).status).toBe(409)
    expect((await w(`/sources/${src.id}`, 'PUT', { fetch_mode: 'curl' })).status).toBe(422)
    expect((await w(`/sources/${src.id}`, 'PUT', { is_active: false })).status).toBe(200)
    for (const [path, row] of [['/sources', src], ['/target-segments', seg], ['/fees', fee], ['/plan-tiers', tier], ['/promotions', promo], ['/features', feature]] as const) {
      expect((await w(`${path}/${row.id}`, 'DELETE')).status).toBe(200)
    }
  })

  it('details: updates both tables in one call; protected and affiliate columns are refused', async () => {
    const res = await w('/details', 'PUT', { account: { minimum_opening_deposit: 123 }, checking: { free_transactions_per_month: 7 } })
    expect(res.status, await res.clone().text()).toBe(200)
    const { data } = await j(res)
    expect(data.account.minimum_opening_deposit).toBe(123)
    expect(data.checking.free_transactions_per_month).toBe(7)
    expect(JSON.stringify(data)).not.toContain('tracker_url')
    expect((await w('/details', 'PUT', { account: { listing_status: 'active' } })).status).toBe(422)
    expect((await w('/details', 'PUT', { account: { is_affiliate_tracked: true } })).status).toBe(422)
    const got = await j(await w('/details', 'GET'))
    expect(got.data.account.minimum_opening_deposit).toBe(123)
  })

  it('pause and resume only move between active and paused, and are audited', async () => {
    expect((await w('/pause', 'POST')).status).toBe(422) // a draft cannot be paused
    await db.from('business_deposit_accounts').update({ listing_status: 'active' }).eq('id', id)
    expect((await j(await w('/pause', 'POST'))).data.listing_status).toBe('paused')
    expect((await j(await w('/pause', 'POST'))).data.listing_status).toBe('paused') // idempotent
    expect((await j(await w('/resume', 'POST'))).data.listing_status).toBe('active')
    const actions = (await audits()).map((r) => r.action)
    expect(actions).toContain('paused')
    expect(actions).toContain('resumed')
  })
})

// The real Supabase JWT path: real auth users, real sign-in, real admin_users lookup. Local only (creates auth users).
// A user JWT must be aal2 (password + TOTP), so these tests enroll and verify a real authenticator, which needs
// [auth.mfa.totp] enroll_enabled/verify_enabled = true in the local supabase/config.toml.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
async function totpCode(secret: string) {
  const bits = [...secret.replace(/=+$/, '').toUpperCase()].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('')
  const key = new Uint8Array(Math.floor(bits.length / 8)).map((_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2))
  const counter = new DataView(new ArrayBuffer(8))
  counter.setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)))
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']), counter))
  const o = hmac[19]! & 15
  const n = ((hmac[o]! & 0x7f) << 24) | (hmac[o + 1]! << 16) | (hmac[o + 2]! << 8) | hmac[o + 3]!
  return String(n % 1_000_000).padStart(6, '0')
}
const claimsOf = (jwt: string) => JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { aal?: string }

describe.runIf(LOCAL)('admin API with real Supabase sessions', () => {
  const password = `Pw-${rand()}`
  const mk = (kind: string) => ({ email: `it-admin-${kind}-${rand().slice(0, 10)}@example.test`, password })
  const adminUser = mk('admin')
  const plainUser = mk('plain')
  const ids: string[] = []
  const jwt: Record<string, string> = {}

  // sign-in goes through GoTrue; a throwaway client so the shared service client keeps its auth state.
  // withTotp: also enroll and verify an authenticator, which upgrades the session to aal2.
  async function signIn(u: { email: string; password: string }, withTotp = false) {
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await client.auth.signInWithPassword(u)
    if (error) throw error
    if (withTotp) {
      const enrolled = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'it' })
      if (enrolled.error) throw new Error(`TOTP enroll failed (is [auth.mfa.totp] enabled in config.toml?): ${enrolled.error.message}`)
      const challenge = await client.auth.mfa.challenge({ factorId: enrolled.data.id })
      if (challenge.error) throw challenge.error
      const verified = await client.auth.mfa.verify({ factorId: enrolled.data.id, challengeId: challenge.data.id, code: await totpCode(enrolled.data.totp.secret) })
      if (verified.error) throw verified.error
      return (await client.auth.getSession()).data.session!.access_token
    }
    return data.session!.access_token
  }

  beforeAll(async () => {
    for (const [kind, u] of [['admin', adminUser], ['plain', plainUser]] as const) {
      const { data, error } = await db.auth.admin.createUser({ ...u, email_confirm: true })
      if (error) throw error
      ids.push(data.user.id)
      if (kind === 'admin') await db.from('admin_users').insert({ user_id: data.user.id })
      jwt[kind] = await signIn(u, kind === 'admin')
    }
    jwt.adminPasswordOnly = await signIn(adminUser) // same account, fresh sign-in: password only, so aal1
  })
  afterAll(async () => {
    for (const id of ids) await db.auth.admin.deleteUser(id) // admin_users row cascades
  })

  it('an admin_users account is accepted; a plain Supabase user is 403; a forged JWT is 401', async () => {
    expect((await api('', { token: jwt.admin })).status).toBe(200)
    expect((await api('', { token: jwt.plain })).status).toBe(403)
    expect((await api('', { token: `${jwt.admin}x` })).status).toBe(401)
  })

  it('MFA is enforced: a password-only session of the same admin is 403, the aal2 session is 200', async () => {
    expect(claimsOf(jwt.adminPasswordOnly!).aal).toBe('aal1')
    expect(claimsOf(jwt.admin!).aal).toBe('aal2')
    const denied = await api('', { token: jwt.adminPasswordOnly })
    expect(denied.status).toBe(403)
    expect((await denied.json()).detail).toMatch(/MFA required/)
    expect((await api('', { token: jwt.admin })).status).toBe(200)
  })

  it('a password-only session cannot add its own authenticator once one is verified', async () => {
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    await client.auth.signInWithPassword(adminUser)
    const second = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'attacker' })
    expect(second.error?.message).toMatch(/AAL2 required/)
  })

  it('a user JWT may write, and the audit trail names the account', async () => {
    const { data: l } = await db.from('business_deposit_accounts').select('id').limit(1).single()
    const res = await api(`/${l!.id}/details`, { method: 'PUT', token: jwt.admin, body: body({}) })
    expect(res.status, await res.clone().text()).toBe(200) // empty patch: authorized, nothing changed, no audit row
  })

  it('removing the admin_users row revokes access on the very next request (no cache)', async () => {
    expect((await api('', { token: jwt.admin })).status).toBe(200)
    await db.from('admin_users').delete().eq('user_id', ids[0]!)
    expect((await api('', { token: jwt.admin })).status).toBe(403)
  })
})
