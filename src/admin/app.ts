import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { Env } from '../types'
import type { Json } from '../lib/database.types'
import { createSupabaseClient } from '../lib/supabase'
import { rateLimit } from '../lib/rate-limit'
import { problem, type ProblemStatus } from '../rest/problem'
import { authenticateAdmin, type Actor } from './auth'
import {
  ACCOUNT_COLUMNS, CHECKING_COLUMNS, ENUM_RESOURCES, INTEGRATION_COLUMNS, RESOURCES, columnsOf, createSchema,
  detailsSchema, enumValueSchema, integrationCreateSchema, integrationUpdateSchema, pick, updateSchema,
  type ResourceName,
} from './resources'

// Admin listing API, mounted at /v1/listings (src/index.ts). Auth, rate limiting and validation all live here;
// the Next.js app is only a client of it. See bancadia-db migrations 095-099 for the write functions.
type Vars = { requestId: string; actor: Actor }
type C = Context<{ Bindings: Env; Variables: Vars }>
const admin = new Hono<{ Bindings: Env; Variables: Vars }>()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FAILED_AUTH_LIMIT_NOTE = 'Retry after the number of seconds in Retry-After.'

// Untyped on purpose: the table name is data (RESOURCES), so the generated per-table types cannot apply.
const db = (c: C) => createSupabaseClient(c.env) as unknown as SupabaseClient

const allowedOrigin = (origin: string, env: Env) =>
  (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean).includes(origin) ? origin : null

admin.use(
  '*',
  cors({
    origin: (origin, c) => allowedOrigin(origin, c.env as Env),
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    maxAge: 600,
  })
)

admin.use('*', async (c, next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  await next()
})

admin.onError((err, c) => {
  // Never log request headers: Authorization carries credentials.
  console.error(`admin unhandled error (request_id=${c.get('requestId')})`, err)
  return problem(c, 500, 'Internal error while processing the request. Please retry.')
})

async function limited(c: C, key: string, kind: 'anonymous' | 'developer') {
  const rl = await rateLimit(c.env, key, kind)
  const resetIn = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))
  c.header('RateLimit-Limit', String(rl.limit))
  c.header('RateLimit-Remaining', String(Math.max(0, rl.remaining)))
  c.header('RateLimit-Reset', String(resetIn))
  return rl.success ? null : problem(c, 429, `Rate limit exceeded. ${FAILED_AUTH_LIMIT_NOTE}`, { 'Retry-After': String(resetIn) })
}

// Every request: per-IP bucket (also slows credential guessing), authenticate, per-actor bucket, scope check.
admin.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next()
  const ipLimited = await limited(c, `admin-ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, 'anonymous')
  if (ipLimited) return ipLimited
  const auth = await authenticateAdmin(c.req.raw, c.env, c.executionCtx)
  if (!auth.ok) return problem(c, auth.status, auth.detail)
  const actorLimited = await limited(c, `admin:${auth.actor.id}`, 'developer')
  if (actorLimited) return actorLimited
  if (c.req.method !== 'GET' && auth.actor.scope !== 'write') {
    return problem(c, 403, 'This token has read scope; it cannot modify listings.')
  }
  c.set('actor', auth.actor)
  await next()
})

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────
const ok = (c: C, data: unknown, status: 200 | 201 = 200) =>
  c.json({ data, meta: { request_id: c.get('requestId') } }, status)

const DB_STATUS: Record<string, ProblemStatus> = {
  P0002: 404, '23505': 409, '23503': 422, '23502': 422, '23514': 422, '22023': 422, '22P02': 422, '22003': 422, '22007': 422,
}
// The messages of these SQLSTATEs describe the caller's input (the 22023/P0002 ones are written by us); anything
// else is an internal error and gets a fixed message.
function dbFail(c: C, error: { message: string; code?: string }) {
  const status = DB_STATUS[error.code ?? '']
  if (status) return problem(c, status, error.message)
  console.error(`admin db error (request_id=${c.get('requestId')}, code=${error.code})`, error.message)
  return problem(c, 500, 'Internal error while processing the request. Please retry.')
}

async function body<S extends z.ZodType>(c: C, schema: S): Promise<{ data: z.infer<S> } | { res: Response }> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return { res: problem(c, 400, 'Request body must be valid JSON.') }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
    return { res: problem(c, 422, detail) }
  }
  return { data: parsed.data }
}

const withListing = (fn: (c: C, id: string) => Promise<Response>) => (c: C) => {
  const id = c.req.param('id') ?? ''
  return UUID.test(id) ? fn(c, id) : Promise.resolve(problem(c, 400, 'listing_id must be a UUID.'))
}

const mutate = (c: C, op: 'create' | 'update' | 'delete', table: string, listingId: string, rowId: string, payload: Json) =>
  db(c).rpc('admin_mutate', {
    p_op: op, p_table: table, p_listing_id: listingId, p_row_id: rowId, p_payload: payload,
    p_actor_id: c.get('actor').id, p_actor_label: c.get('actor').label,
  })

async function listingExists(c: C, id: string) {
  const { data, error } = await db(c).from('business_deposit_accounts').select('id').eq('id', id).maybeSingle()
  return error ? { error } : { exists: !!data }
}

const NOT_FOUND = 'No such listing or row.'

// ── listings ───────────────────────────────────────────────────────────────────────────────────────────────
admin.get('/', async (c) => {
  let q = db(c)
    .from('business_deposit_accounts')
    .select('id, listing_slug, product_name, listing_status, last_modified, institutions(name, display_name)')
    .order('listing_slug')
  const slug = c.req.query('slug')
  if (slug) q = q.eq('listing_slug', slug)
  const { data, error } = await q
  if (error) return dbFail(c, error)
  return ok(c, (data ?? []).map(({ institutions, ...row }: Record<string, unknown>) => ({ ...row, institution: institutions })))
})

// literal paths first so /enums and /vocab are never read as a listing id
admin.get('/vocab/integrations', async (c) => {
  const { data, error } = await db(c).from('integration_vocab').select('slug, label, kind').order('slug')
  return error ? dbFail(c, error) : ok(c, data)
})

admin.get('/enums/:resource', async (c) => {
  const resource = c.req.param('resource')
  if (!ENUM_RESOURCES.includes(resource)) return problem(c, 404, 'Unknown resource.')
  const { data, error } = await db(c).rpc('admin_field_enums', { p_resource: resource })
  return error ? dbFail(c, error) : ok(c, data)
})

admin.post('/enums/:resource/:field', async (c) => {
  const resource = c.req.param('resource')
  if (!ENUM_RESOURCES.includes(resource)) return problem(c, 404, 'Unknown resource.')
  const parsed = await body(c, enumValueSchema)
  if ('res' in parsed) return parsed.res
  const field = c.req.param('field')
  const { data, error } = await db(c).rpc('admin_add_enum_value', { p_resource: resource, p_field: field, p_value: parsed.data.value })
  if (error) return dbFail(c, error)
  console.info(`admin enum value added resource=${resource} field=${field} value=${parsed.data.value} actor=${c.get('actor').label}`)
  return ok(c, { field, values: data }, 201)
})

const NESTED = [
  `business_checking_details(${CHECKING_COLUMNS.join(',')})`,
  ...(Object.keys(RESOURCES) as ResourceName[])
    .filter((n) => n !== 'features')
    .map((n) => `${RESOURCES[n].table}(${columnsOf(RESOURCES[n]).join(',')})`),
  `business_deposit_account_features(${columnsOf(RESOURCES.features).join(',')}, business_deposit_feature_integrations(${INTEGRATION_COLUMNS.join(',')}))`,
  'institutions(name, display_name)',
].join(', ')

const bySortOrder = (rows: Record<string, unknown>[] | null | undefined, keys: string[]) =>
  [...(rows ?? [])].sort((a, b) => {
    for (const k of keys) {
      const [x, y] = [a[k] as string | number | null, b[k] as string | number | null]
      if (x === y) continue
      if (x == null) return 1
      if (y == null) return -1
      return x < y ? -1 : 1
    }
    return 0
  })

admin.get('/:id', withListing(async (c, id) => {
  const { data, error } = await db(c)
    .from('business_deposit_accounts')
    .select(`${ACCOUNT_COLUMNS.join(',')}, ${NESTED}`)
    .eq('id', id)
    .maybeSingle()
  if (error) return dbFail(c, error)
  if (!data) return problem(c, 404, NOT_FOUND)
  const row = data as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const rel = (n: ResourceName) => bySortOrder(row[RESOURCES[n].table], RESOURCES[n].order)
  return ok(c, {
    account: { ...pick(row, ACCOUNT_COLUMNS), institution: row.institutions },
    checking: row.business_checking_details ?? null,
    fees: rel('fees'),
    features: rel('features'),
    plan_tiers: rel('plan-tiers'),
    promotions: rel('promotions'),
    target_segments: rel('target-segments'),
    sources: rel('sources'),
  })
}))

admin.post('/:id/pause', withListing(async (c, id) => setStatus(c, id, 'paused')))
admin.post('/:id/resume', withListing(async (c, id) => setStatus(c, id, 'active')))
async function setStatus(c: C, id: string, status: 'paused' | 'active') {
  const { data, error } = await db(c).rpc('admin_set_status', {
    p_listing_id: id, p_status: status, p_actor_id: c.get('actor').id, p_actor_label: c.get('actor').label,
  })
  return error ? dbFail(c, error) : ok(c, data)
}

// ── details (accounts + checking details, one transaction) ───────────────────────────────────────────────────
admin.get('/:id/details', withListing(async (c, id) => {
  const [account, checking] = await Promise.all([
    db(c).from('business_deposit_accounts').select(ACCOUNT_COLUMNS.join(',')).eq('id', id).maybeSingle(),
    db(c).from('business_checking_details').select(CHECKING_COLUMNS.join(',')).eq('listing_id', id).maybeSingle(),
  ])
  if (account.error) return dbFail(c, account.error)
  if (checking.error) return dbFail(c, checking.error)
  if (!account.data) return problem(c, 404, NOT_FOUND)
  return ok(c, { account: account.data, checking: checking.data })
}))

admin.put('/:id/details', withListing(async (c, id) => {
  const parsed = await body(c, detailsSchema)
  if ('res' in parsed) return parsed.res
  const { data, error } = await db(c).rpc('admin_update_details', {
    p_listing_id: id,
    p_accounts: (parsed.data.account ?? {}) as Json,
    p_details: (parsed.data.checking ?? {}) as Json,
    p_actor_id: c.get('actor').id,
    p_actor_label: c.get('actor').label,
  })
  if (error) return dbFail(c, error)
  const r = data as Record<string, Record<string, unknown>>
  return ok(c, { account: pick(r.business_deposit_accounts, ACCOUNT_COLUMNS), checking: pick(r.business_checking_details, CHECKING_COLUMNS) })
}))

// ── single-table sub-resources: fees, features, promotions, plan-tiers, target-segments, sources ───────────────────────
for (const name of Object.keys(RESOURCES) as ResourceName[]) {
  const r = RESOURCES[name]
  const cols = columnsOf(r)
  const create = createSchema(r)
  const update = updateSchema(r)

  admin.get(`/:id/${name}`, withListing(async (c, id) => {
    const exists = await listingExists(c, id)
    if ('error' in exists) return dbFail(c, exists.error!)
    if (!exists.exists) return problem(c, 404, NOT_FOUND)
    let q = db(c).from(r.table).select(cols.join(',')).eq('listing_id', id)
    for (const k of r.order) q = q.order(k, { nullsFirst: false })
    const { data, error } = await q
    return error ? dbFail(c, error) : ok(c, data)
  }))

  admin.post(`/:id/${name}`, withListing(async (c, id) => {
    const parsed = await body(c, create)
    if ('res' in parsed) return parsed.res
    const { data, error } = await mutate(c, 'create', r.table, id, '', parsed.data as Json)
    return error ? dbFail(c, error) : ok(c, pick(data as Record<string, unknown>, cols), 201)
  }))

  admin.get(`/:id/${name}/:row_id`, withListing(async (c, id) => {
    const { data, error } = await db(c).from(r.table).select(cols.join(',')).eq('id', c.req.param('row_id') ?? '').eq('listing_id', id).maybeSingle()
    if (error) return dbFail(c, error)
    return data ? ok(c, data) : problem(c, 404, NOT_FOUND)
  }))

  admin.put(`/:id/${name}/:row_id`, withListing(async (c, id) => {
    const parsed = await body(c, update)
    if ('res' in parsed) return parsed.res
    const { data, error } = await mutate(c, 'update', r.table, id, c.req.param('row_id') ?? '', parsed.data as Json)
    return error ? dbFail(c, error) : ok(c, pick(data as Record<string, unknown>, cols))
  }))

  admin.delete(`/:id/${name}/:row_id`, withListing(async (c, id) => {
    const { data, error } = await mutate(c, 'delete', r.table, id, c.req.param('row_id') ?? '', {})
    return error ? dbFail(c, error) : ok(c, pick(data as Record<string, unknown>, cols))
  }))
}

// ── feature integrations: key is (feature_id, integration_slug); ownership is through the feature ─────────────
const INTEGRATION_SELECT = `${INTEGRATION_COLUMNS.join(',')}, business_deposit_account_features!inner(listing_id)`
const integrationRow = ({ business_deposit_account_features: _join, ...row }: Record<string, unknown>) => row
const asRows = (data: unknown) => (data ?? []) as Record<string, unknown>[]

const integrationQuery = (c: C, listingId: string) =>
  db(c).from('business_deposit_feature_integrations').select(INTEGRATION_SELECT).eq('business_deposit_account_features.listing_id', listingId)

admin.get('/:id/integrations', withListing(async (c, id) => {
  const { data, error } = await integrationQuery(c, id).order('feature_id').order('integration_slug')
  return error ? dbFail(c, error) : ok(c, asRows(data).map(integrationRow))
}))

const withFeature = (fn: (c: C, id: string, featureId: string) => Promise<Response>) =>
  withListing((c, id) => {
    const featureId = c.req.param('feature_id') ?? ''
    return UUID.test(featureId) ? fn(c, id, featureId) : Promise.resolve(problem(c, 400, 'feature_id must be a UUID.'))
  })

const slugParam = (c: C) => {
  const slug = c.req.param('slug') ?? ''
  return slug && !slug.includes('/') ? slug : null
}

admin.get('/:id/features/:feature_id/integrations', withFeature(async (c, id, featureId) => {
  const { data, error } = await integrationQuery(c, id).eq('feature_id', featureId).order('integration_slug')
  return error ? dbFail(c, error) : ok(c, asRows(data).map(integrationRow))
}))

admin.post('/:id/features/:feature_id/integrations', withFeature(async (c, id, featureId) => {
  const parsed = await body(c, integrationCreateSchema)
  if ('res' in parsed) return parsed.res
  const { data, error } = await mutate(c, 'create', 'business_deposit_feature_integrations', id, '', { ...parsed.data, feature_id: featureId } as Json)
  return error ? dbFail(c, error) : ok(c, pick(data as Record<string, unknown>, INTEGRATION_COLUMNS), 201)
}))

admin.get('/:id/features/:feature_id/integrations/:slug', withFeature(async (c, id, featureId) => {
  const slug = slugParam(c)
  if (!slug) return problem(c, 400, 'Invalid integration slug.')
  const { data, error } = await integrationQuery(c, id).eq('feature_id', featureId).eq('integration_slug', slug).maybeSingle()
  if (error) return dbFail(c, error)
  return data ? ok(c, integrationRow(data as unknown as Record<string, unknown>)) : problem(c, 404, NOT_FOUND)
}))

admin.put('/:id/features/:feature_id/integrations/:slug', withFeature(async (c, id, featureId) => {
  const slug = slugParam(c)
  if (!slug) return problem(c, 400, 'Invalid integration slug.')
  const parsed = await body(c, integrationUpdateSchema)
  if ('res' in parsed) return parsed.res
  const { data, error } = await mutate(c, 'update', 'business_deposit_feature_integrations', id, `${featureId}/${slug}`, parsed.data as Json)
  return error ? dbFail(c, error) : ok(c, pick(data as Record<string, unknown>, INTEGRATION_COLUMNS))
}))

admin.delete('/:id/features/:feature_id/integrations/:slug', withFeature(async (c, id, featureId) => {
  const slug = slugParam(c)
  if (!slug) return problem(c, 400, 'Invalid integration slug.')
  const { data, error } = await mutate(c, 'delete', 'business_deposit_feature_integrations', id, `${featureId}/${slug}`, {})
  return error ? dbFail(c, error) : ok(c, pick(data as Record<string, unknown>, INTEGRATION_COLUMNS))
}))

// Anything else under /v1/listings is ours to 404 (never fall through to the public /v1 router and its caching headers).
admin.all('*', (c) => problem(c, 404, 'Unknown endpoint.'))

export default admin
