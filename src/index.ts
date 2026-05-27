import { Hono } from 'hono'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { Env } from './types'
import { getToolManifest } from './lib/tools'
import { authenticate } from './lib/auth'
import { handleQueryHysa } from './handlers/query-hysa'
import { handleQueryBusinessChecking } from './handlers/query-business-checking'

const app = new Hono<{ Bindings: Env }>()

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }))

// Story 6.1: public MCP discovery
app.get('/.well-known/mcp', (c) =>
  c.json({
    name: 'Bancadia MCP',
    version: '1.0.0',
    endpoint: 'https://mcp.bancadia.com',
    tools_list: 'https://mcp.bancadia.com/',
  })
)

// Story 6.1 + 6.2 + 6.3 + 6.4: JSON-RPC 2.0 endpoint
app.post('/', async (c) => {
  const body = await c.req.json<{
    jsonrpc: string
    id: unknown
    method: string
    params?: unknown
  }>()
  const { id, method, params } = body

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

    if (name === 'query_hysa') {
      const results = await handleQueryHysa(args, c.env)
      return c.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(results) }],
        },
      })
    }

    if (name === 'query_business_checking') {
      const results = await handleQueryBusinessChecking(args, c.env)
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
