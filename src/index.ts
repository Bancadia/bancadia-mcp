import { Hono } from 'hono'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { Env } from './types'
import { TOOLS, getToolManifest } from './lib/tools'
import { authenticate } from './lib/auth'
import { handleQueryBusinessChecking } from './handlers/query-business-checking'

const app = new Hono<{ Bindings: Env }>()

const SERVER_NAME = 'Bancadia MCP'
const SERVER_VERSION = '2.0.0'

// MCP protocol lifecycle versions this server understands, newest first.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

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

// Story 6.1 + 6.2 + 6.3 + 6.4: JSON-RPC 2.0 endpoint
app.post('/', async (c) => {
  const body = await c.req.json<{
    jsonrpc: string
    id?: unknown
    method: string
    params?: unknown
  }>()
  const { id, method, params } = body

  // JSON-RPC notifications omit `id` entirely and MUST NOT receive a response
  // body (e.g. the client's `notifications/initialized` after our `initialize`
  // response). Acknowledge with an empty 202 rather than falling through to
  // the "method not found" branch below.
  if (id === undefined) {
    return c.body(null, 202)
  }

  // initialize — first call in the MCP lifecycle, no auth required
  if (method === 'initialize') {
    const requested = (params as { protocolVersion?: string } | undefined)?.protocolVersion
    const protocolVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION

    return c.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    })
  }

  // tools/list — no auth required
  if (method === 'tools/list') {
    return c.json({ jsonrpc: '2.0', id, result: getToolManifest() })
  }

  // All other methods require auth
  if (method === 'tools/call') {
    const { valid, tokenHash } = await authenticate(c.req.raw, c.env, c.executionCtx)
    if (!valid) {
      return c.json(
        {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32001,
            message:
              'Unauthorized. Register at bancadia.com/developer/signup to obtain an API token.',
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

    const rlHeaders = {
      'X-RateLimit-Limit': String(rlLimit),
      'X-RateLimit-Remaining': String(remaining),
      'X-RateLimit-Reset': String(Math.floor(reset / 1000)),
    }

    if (!success) {
      Object.entries(rlHeaders).forEach(([k, v]) => c.header(k, v))
      return c.json(
        { jsonrpc: '2.0', id, error: { code: -32029, message: 'Rate limit exceeded.' } },
        429
      )
    }

    Object.entries(rlHeaders).forEach(([k, v]) => c.header(k, v))

    const { name, arguments: args = {} } = params as {
      name: string
      arguments?: Record<string, unknown>
    }

    type ToolHandler = (args: Record<string, unknown>, env: Env) => Promise<object[]>

    const toolHandlers: Record<string, ToolHandler> = {
      query_business_checking: handleQueryBusinessChecking,
    }

    const handler = toolHandlers[name]
    if (handler) {
      const results = await handler(args, c.env)
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(results) }],
        },
      })
    }

    return c.json(
      { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } },
      404
    )
  }

  return c.json(
    { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } },
    404
  )
})

export default app
