import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types'
import { authenticate } from '../lib/auth'
import { rateLimit } from '../lib/rate-limit'
import { recordQueryEvent, type QueryMeta } from '../lib/analytics'
import { runTool, type RunToolResult } from '../lib/run-tool'
import { TOOLS_V2 } from '../lib/tools-v2'
import { parseQueryParams } from './params'
import { problem } from './problem'
import { buildOpenApi } from '../lib/openapi'

type Vars = { requestId: string }
const rest = new Hono<{ Bindings: Env; Variables: Vars }>()

const LINK =
  '<https://bancadia.com/docs/rest-api>; rel="service-doc", <https://api.bancadia.com/v1/openapi.json>; rel="service-desc"'

rest.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'Link'],
    maxAge: 86400,
  })
)

rest.use('*', async (c, next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  c.header('Cache-Control', 'public, max-age=60')
  c.header('Link', LINK)
  await next()
})

rest.onError((err, c) => {
  console.error(`rest unhandled error (request_id=${c.get('requestId')})`, err)
  return problem(c, 500, 'Internal error while processing the request. Please retry.')
})

// Auth + rate limit for every data route. Returns a Response to short-circuit, else the developerId.
async function gate(c: import('hono').Context<{ Bindings: Env; Variables: Vars }>) {
  const auth = await authenticate(c.req.raw, c.env, c.executionCtx)
  // An invalid token still counts against the caller's IP bucket (brute-force guard).
  const key =
    auth.kind === 'developer' ? `token:${auth.tokenHash}` : `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`
  const rl = await rateLimit(c.env, key, auth.kind === 'developer' ? 'developer' : 'anonymous')
  const resetIn = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))
  c.header('RateLimit-Limit', String(rl.limit))
  c.header('RateLimit-Remaining', String(Math.max(0, rl.remaining)))
  c.header('RateLimit-Reset', String(resetIn))
  if (!rl.success) {
    return problem(c, 429, 'Rate limit exceeded. Retry after the number of seconds in Retry-After.', {
      'Retry-After': String(resetIn),
    })
  }
  if (auth.kind === 'invalid') {
    return problem(
      c,
      401,
      'The API token is optional, but the one provided is invalid or revoked. Omit the Authorization header to call anonymously, or get a token at https://bancadia.com/developer/signup.'
    )
  }
  return { developerId: auth.kind === 'developer' ? auth.developerId : null }
}

function metaFor(c: import('hono').Context<{ Bindings: Env; Variables: Vars }>, toolName: string, developerId: string | null): QueryMeta {
  return {
    toolName,
    developerId,
    channel: 'rest',
    sessionId: null,
    userAgent: c.req.header('User-Agent') ?? null,
    requestId: c.get('requestId'),
  }
}

function failure(c: import('hono').Context<{ Bindings: Env; Variables: Vars }>, r: Exclude<RunToolResult, { status: 'ok' }>) {
  return r.status === 'invalid_args'
    ? problem(c, 400, r.message)
    : problem(c, 500, 'Internal error while querying listings. Please retry.')
}

// Static document: no auth or rate limit, same /v1 headers and CORS as the data routes.
rest.get('/openapi.json', (c) => c.json(buildOpenApi()))

type Ctx = import('hono').Context<{ Bindings: Env; Variables: Vars }>
type Payload = any // eslint-disable-line @typescript-eslint/no-explicit-any

// Shared by every data route: gate, parse query params against `schema`, run the v2 tool, shape the envelope.
async function serve(
  c: Ctx,
  toolName: string,
  schema: { properties?: Record<string, { type?: string } | undefined> },
  toArgs: (parsed: Record<string, unknown>) => Record<string, unknown>,
  shape: (payload: Payload) => { data: unknown; extra?: Record<string, unknown> } | null
) {
  const g = await gate(c)
  if (g instanceof Response) return g
  const meta = metaFor(c, toolName, g.developerId)

  const parsed = parseQueryParams(new URL(c.req.url).searchParams, schema)
  if ('error' in parsed) {
    c.executionCtx.waitUntil(
      recordQueryEvent(c.env, meta, Object.fromEntries(new URL(c.req.url).searchParams), {
        status: 'invalid_args',
        errorMessage: parsed.error,
      })
    )
    return problem(c, 400, parsed.error)
  }
  const args = toArgs(parsed.args)
  const r = await runTool(toolName, args, meta, c.env, c.executionCtx)
  if (r.status !== 'ok') return failure(c, r)
  const shaped = shape(r.results)
  if (!shaped) return problem(c, 404, 'No business checking listing with that listing_slug.')
  const count = Array.isArray(shaped.data) ? shaped.data.length : 1
  return c.json({ data: shaped.data, meta: { count, request_id: meta.requestId, filters: args, ...shaped.extra } })
}

// Everything in the payload except the array that became `data`.
const without = (p: Payload, key: string) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== key))

const schemaOf = (name: string) => TOOLS_V2.find((t) => t.name === name)!.inputSchema
const same = (a: Record<string, unknown>) => a

const NOT_FOUND = 'Unknown endpoint. See https://api.bancadia.com/v1/openapi.json.'
const L = '/business-checking-listings'

const list = (c: Ctx) =>
  serve(c, 'list_business_checking', schemaOf('list_business_checking'), same, (p) => ({ data: p.rows, extra: without(p, 'rows') }))

// `-` is the wildcard segment ("across all listings"), never a slug.
const single = (c: Ctx) =>
  c.req.param('listing_slug') === '-'
    ? problem(c, 404, NOT_FOUND)
    : serve(
        c,
        'get_listing',
        { properties: { sections: schemaOf('get_listing').properties.sections } },
        (a) => ({ slugs: [c.req.param('listing_slug')], ...a }),
        (p) => (p.listings.length ? { data: p.listings[0] } : null)
      )

rest.get(`${L}/-/facts`, (c) =>
  serve(c, 'search_facts', schemaOf('search_facts'), same, (p) => ({ data: p.hits, extra: without(p, 'hits') })))
rest.get(`${L}/-/fees`, (c) =>
  serve(c, 'fees_by_type', schemaOf('fees_by_type'), same, (p) => ({ data: p })))
// Sub-resources take no query params; data is that section's array, meta.listing carries the tagged link.
const SECTIONS = { fees: 'fees', features: 'features', promotions: 'promotions', plans: 'tiers' } as const
for (const [route, section] of Object.entries(SECTIONS)) {
  rest.get(`${L}/:listing_slug/${route}`, (c) =>
    c.req.param('listing_slug') === '-'
      ? problem(c, 404, NOT_FOUND)
      : serve(
          c,
          'get_listing',
          { properties: {} },
          () => ({ slugs: [c.req.param('listing_slug')], sections: [section] }),
          (p) => {
            const l = p.listings[0]
            return l
              ? { data: l[section] ?? [], extra: { listing: { listing_slug: l.slug, application_url: l.application_url } } }
              : null
          }
        ))
}

rest.get(L, list)
rest.get(`${L}/:listing_slug`, single)

// Deprecated aliases: same handlers, plus Deprecation and successor-version headers.
const deprecated = (c: Ctx, successor: string) => {
  c.header('Deprecation', 'true')
  c.header('Link', `<${successor}>; rel="successor-version"`, { append: true })
}
rest.get('/business-checking', (c) => {
  deprecated(c, `/v1${L}`)
  return list(c)
})
rest.get('/business-checking/:listing_slug', (c) => {
  deprecated(c, `/v1${L}/${c.req.param('listing_slug')}`)
  return single(c)
})

rest.all('*', (c) => problem(c, 404, 'Unknown endpoint. See https://api.bancadia.com/v1/openapi.json.'))

export default rest
