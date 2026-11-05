import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from '../types'
import { authenticate } from '../lib/auth'
import { rateLimit } from '../lib/rate-limit'
import { recordQueryEvent, type QueryMeta } from '../lib/analytics'
import { runTool, type RunToolResult } from '../lib/run-tool'
import { TOOLS } from '../lib/tools'
import { parseQueryParams } from './params'
import { problem } from './problem'

type Vars = { requestId: string }
const rest = new Hono<{ Bindings: Env; Variables: Vars }>()

const LINK =
  '<https://bancadia.com/docs/rest-api>; rel="service-doc", <https://api.bancadia.com/v1/openapi.json>; rel="service-desc"'

const schemaOf = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema

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

rest.get('/business-checking', async (c) => {
  const g = await gate(c)
  if (g instanceof Response) return g
  const meta = metaFor(c, 'query_business_checking', g.developerId)

  const parsed = parseQueryParams(new URL(c.req.url).searchParams, schemaOf(meta.toolName))
  if ('error' in parsed) {
    c.executionCtx.waitUntil(
      recordQueryEvent(c.env, meta, Object.fromEntries(new URL(c.req.url).searchParams), {
        status: 'invalid_args',
        errorMessage: parsed.error,
      })
    )
    return problem(c, 400, parsed.error)
  }
  const r = await runTool(meta.toolName, parsed.args, meta, c.env, c.executionCtx)
  if (r.status !== 'ok') return failure(c, r)
  return c.json({
    data: r.results,
    meta: { count: r.results.length, request_id: meta.requestId, filters: parsed.args },
  })
})

rest.get('/business-checking/:listing_slug', async (c) => {
  const g = await gate(c)
  if (g instanceof Response) return g
  const meta = metaFor(c, 'get_business_checking_listing', g.developerId)

  const r = await runTool(meta.toolName, { listing_slug: c.req.param('listing_slug') }, meta, c.env, c.executionCtx)
  if (r.status !== 'ok') return failure(c, r)
  if (r.results.length === 0) return problem(c, 404, 'No business checking listing with that listing_slug.')
  return c.json({ data: r.results[0], meta: { count: 1, request_id: meta.requestId } })
})

rest.all('*', (c) => problem(c, 404, 'Unknown endpoint. See https://api.bancadia.com/v1/openapi.json.'))

export default rest
