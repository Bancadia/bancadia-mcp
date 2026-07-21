import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { Env } from './types'
import { TOOLS, getToolManifest } from './lib/tools'
import { authenticate } from './lib/auth'
import { validateOrigin } from './lib/origin'
import { createSession, validateSession, deleteSession, SESSION_HEADER } from './lib/session'
import { handleQueryBusinessChecking } from './handlers/query-business-checking'
import { handleGetBusinessCheckingListing } from './handlers/get-business-checking-listing'

const app = new Hono<{ Bindings: Env }>()

const SERVER_NAME = 'Bancadia MCP'
const SERVER_VERSION = '2.0.0'

// MCP protocol lifecycle versions this server understands, newest first.
const LATEST_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-03-26', '2024-11-05']

const PROTOCOL_VERSION_HEADER = 'MCP-Protocol-Version'

// A standalone GET SSE stream that never had server-initiated messages to
// send is kept alive with periodic pings and self-closed after this long,
// so a spec-compliant client just reconnects rather than the Worker holding
// the connection open indefinitely.
const GET_STREAM_MAX_DURATION_MS = 60_000
const GET_STREAM_PING_INTERVAL_MS = 15_000

type JsonRpcStatus = 200 | 400 | 401 | 404 | 429
type JsonRpcPayload = { result: unknown } | { error: { code: number; message: string } }

// Picks plain-JSON vs SSE response mode based on the request's Accept
// header. Only 200 responses are eligible for SSE mode — HTTP-level errors
// (bad session, auth failure, rate limit) are always plain JSON, since
// there's nothing to stream for those.
function sendJsonRpc(
  c: Context<{ Bindings: Env }>,
  id: unknown,
  payload: JsonRpcPayload,
  status: JsonRpcStatus = 200
): Response | Promise<Response> {
  const body = { jsonrpc: '2.0', id, ...payload }

  if (status === 200 && (c.req.header('Accept') ?? '').includes('text/event-stream')) {
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'message', data: JSON.stringify(body) })
      await stream.close()
    })
  }

  return c.json(body, status)
}

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }))

// Story 6.1: public MCP discovery
app.get('/.well-known/mcp', (c) =>
  c.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    endpoint: 'https://mcp.bancadia.com',
    tools_list: 'https://mcp.bancadia.com/',
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  })
)

// Story 6.1 + 6.2 + 6.3 + 6.4: JSON-RPC 2.0 / MCP Streamable HTTP endpoint
app.post('/', async (c) => {
  if (!validateOrigin(c.req.raw, c.env)) {
    return c.text('Forbidden', 403)
  }

  const body = await c.req.json<{
    jsonrpc: string
    id?: unknown
    method: string
    params?: unknown
  }>()
  const { id, method, params } = body
  const isNotification = id === undefined

  // Every method except `initialize` requires a previously-issued session.
  if (method !== 'initialize') {
    const session = await validateSession(c.req.raw, c.env, c.executionCtx)
    if (!session.ok) {
      if (isNotification) {
        return c.body(null, session.status)
      }
      return sendJsonRpc(
        c,
        id,
        {
          error: {
            code: -32600,
            message:
              session.status === 400
                ? `Missing ${SESSION_HEADER} header.`
                : 'Session not found or expired. Re-initialize.',
          },
        },
        session.status
      )
    }

    const protocolHeader = c.req.header(PROTOCOL_VERSION_HEADER)
    if (protocolHeader && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolHeader)) {
      if (isNotification) {
        return c.body(null, 400)
      }
      return sendJsonRpc(
        c,
        id,
        { error: { code: -32600, message: `Unsupported ${PROTOCOL_VERSION_HEADER}: ${protocolHeader}` } },
        400
      )
    }
  }

  // JSON-RPC notifications omit `id` entirely and MUST NOT receive a response
  // body (e.g. the client's `notifications/initialized` after our `initialize`
  // response). Acknowledge with an empty 202 rather than falling through to
  // the "method not found" branch below.
  if (isNotification) {
    return c.body(null, 202)
  }

  // initialize — first call in the MCP lifecycle, no auth required
  if (method === 'initialize') {
    const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion
    const protocolVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION

    const sessionId = await createSession(c.env, protocolVersion)
    c.header(SESSION_HEADER, sessionId)

    return sendJsonRpc(c, id, {
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    })
  }

  // tools/list — session required (checked above), no bearer auth required
  if (method === 'tools/list') {
    return sendJsonRpc(c, id, { result: getToolManifest() })
  }

  // tools/call — session required (checked above), plus bearer auth
  if (method === 'tools/call') {
    const { valid, tokenHash } = await authenticate(c.req.raw, c.env, c.executionCtx)
    if (!valid) {
      return sendJsonRpc(
        c,
        id,
        {
          error: {
            code: -32001,
            message: 'Unauthorized. Register at bancadia.com/developer/signup to obtain an API token.',
          },
        },
        401
      )
    }

    // Per-token rate limiting
    const limit = parseInt(c.env.RATE_LIMIT_REQUESTS ?? '100')
    const window = parseInt(c.env.RATE_LIMIT_WINDOW_SECONDS ?? '60')
    const ratelimit = new Ratelimit({
      redis: new Redis({ url: c.env.UPSTASH_REDIS_REST_URL, token: c.env.UPSTASH_REDIS_REST_TOKEN }),
      limiter: Ratelimit.slidingWindow(limit, `${window} s`),
      prefix: 'rl',
    })
    const { success, limit: rlLimit, remaining, reset } = await ratelimit.limit(`token:${tokenHash}`)

    c.header('X-RateLimit-Limit', String(rlLimit))
    c.header('X-RateLimit-Remaining', String(remaining))
    c.header('X-RateLimit-Reset', String(Math.floor(reset / 1000)))

    if (!success) {
      return sendJsonRpc(c, id, { error: { code: -32029, message: 'Rate limit exceeded.' } }, 429)
    }

    const { name, arguments: args = {} } = params as {
      name: string
      arguments?: Record<string, unknown>
    }

    type ToolHandler = (args: Record<string, unknown>, env: Env) => Promise<object[]>

    const toolHandlers: Record<string, ToolHandler> = {
      query_business_checking: handleQueryBusinessChecking,
      get_business_checking_listing: handleGetBusinessCheckingListing,
    }

    const handler = toolHandlers[name]
    if (handler) {
      const results = await handler(args, c.env)
      return sendJsonRpc(c, id, {
        result: {
          content: [{ type: 'text', text: JSON.stringify(results) }],
        },
      })
    }

    return sendJsonRpc(c, id, { error: { code: -32601, message: `Unknown tool: ${name}` } }, 404)
  }

  return sendJsonRpc(c, id, { error: { code: -32601, message: `Method not found: ${method}` } }, 404)
})

// Standalone SSE stream for server-initiated messages. No tool emits any
// today, so this is a minimal spec-compliant stream (keep-alives, bounded
// lifetime) rather than a real push channel.
app.get('/', async (c) => {
  if (!validateOrigin(c.req.raw, c.env)) {
    return c.text('Forbidden', 403)
  }

  if (!(c.req.header('Accept') ?? '').includes('text/event-stream')) {
    return c.text('Method Not Allowed', 405)
  }

  const session = await validateSession(c.req.raw, c.env, c.executionCtx)
  if (!session.ok) {
    return c.body(null, session.status)
  }

  return streamSSE(c, async (stream) => {
    const deadline = Date.now() + GET_STREAM_MAX_DURATION_MS
    while (!stream.aborted && !stream.closed && Date.now() < deadline) {
      await stream.writeSSE({ event: 'ping', data: '' })
      await stream.sleep(GET_STREAM_PING_INTERVAL_MS)
    }
    await stream.close()
  })
})

// Client-initiated session termination
app.delete('/', async (c) => {
  if (!validateOrigin(c.req.raw, c.env)) {
    return c.text('Forbidden', 403)
  }

  const session = await validateSession(c.req.raw, c.env, c.executionCtx)
  if (!session.ok) {
    return c.body(null, session.status)
  }

  await deleteSession(c.env, session.sessionId)
  return c.body(null, 204)
})

export default app
