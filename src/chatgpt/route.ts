import { Hono } from 'hono'
import type { Env } from '../types'
import { runTool, failureMessage } from '../lib/run-tool'
import { rateLimit } from '../lib/rate-limit'
import { validateOrigin } from '../lib/origin'
import { newQueryMeta } from '../lib/analytics'
import { negotiateProtocolVersion } from '../lib/mcp-protocol'
import { WIDGET_URI, WIDGET_MIME, WIDGET_HTML } from './widget'
import { presentRow } from './present'
import {
  V2_LIST, DEFAULT_LIMIT, MAX_LIMIT, CARD_FIELDS, CONTEXT_FIELDS,
  DATA_TOOLS, TOOL_LIST, shapeData, unknownFieldNames,
} from './tools'

// ChatGPT App surface: stateless MCP over plain JSON (no Mcp-Session-Id), noauth, read-only.
// Protocol and dispatch only: every tool runs through the shared runTool/V2_HANDLERS path, so query
// logic, validation, link tagging and logging are not duplicated here (definitions are in ./tools).
const DATA_CALL_TEXT = 'Answer using only fields in structuredContent. Write no links and add no facts that are not in the data.'

type Rpc = { jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }

const chatgpt = new Hono<{ Bindings: Env }>()

chatgpt.post('/mcp', async (c) => {
  if (!validateOrigin(c.req.raw, c.env)) return c.text('Forbidden', 403)

  let body: Rpc
  try {
    body = await c.req.json<Rpc>()
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }
  const { id, method, params = {} } = body
  if (id === undefined) return c.body(null, 202) // notification
  const ok = (result: unknown) => c.json({ jsonrpc: '2.0', id, result })
  const err = (code: number, message: string, status: 200 | 400 | 404 | 429 = 200) =>
    c.json({ jsonrpc: '2.0', id, error: { code, message } }, status)

  switch (method) {
    case 'initialize': {
      return ok({
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'Bancadia', version: '0.1.0' },
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOL_LIST })
    case 'resources/list':
      return ok({ resources: [{ uri: WIDGET_URI, name: 'Business checking results', mimeType: WIDGET_MIME }] })
    case 'resources/read': {
      if (params.uri !== WIDGET_URI) return err(-32002, `Resource not found: ${String(params.uri)}`)
      return ok({
        contents: [{
          uri: WIDGET_URI,
          mimeType: WIDGET_MIME,
          text: WIDGET_HTML,
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
        }],
      })
    }
    case 'tools/call': {
      const name = String(params.name)
      const data = DATA_TOOLS[name]
      if (name !== V2_LIST && !data) return err(-32601, `Unknown tool: ${name}`, 404)

      // shortcut: ChatGPT calls arrive from shared OpenAI IPs, so a per-IP key is effectively one global bucket; revisit before launch.
      const rl = await rateLimit(c.env, `chatgpt:ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, 'developer')
      if (!rl.success) return err(-32029, 'Rate limit exceeded.', 429)

      // ChatGPT's anonymized conversation id; links a search to the get_listing that follows it. Opaque, untrusted input: string only, capped.
      const hostMeta = (params._meta ?? {}) as Record<string, unknown>
      const session = hostMeta['openai/session']
      const chatConversationId = typeof session === 'string' && session ? session.slice(0, 200) : null

      const meta = (toolName: string) => newQueryMeta(c.req.raw, { toolName, developerId: null, channel: 'chatgpt', sessionId: null, chatConversationId })
      const fail = (text: string) => ok({ isError: true, content: [{ type: 'text', text }] })
      const callArgs = (params.arguments as Record<string, unknown> | undefined) ?? {}

      if (data) {
        const r = await runTool(name, { ...data.defaults, ...callArgs }, meta(name), c.env, c.executionCtx)
        if (r.status !== 'ok') return fail(failureMessage(r))
        const shaped = shapeData(r.results)
        if (data.empty && !(shaped[data.key] as unknown[] | undefined)?.length) return fail(data.empty)
        return ok({ structuredContent: shaped, content: [{ type: 'text', text: DATA_CALL_TEXT }] })
      }

      const args: Record<string, unknown> = { ...callArgs }
      args.limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)
      // The *_display strings are ours (added after the query), never columns, so drop them if the model requests them.
      const asked = ((args.fields as string[] | undefined) ?? []).filter((f) => !f.endsWith('_display'))
      args.fields = [...new Set([...CARD_FIELDS, ...CONTEXT_FIELDS, ...asked])]

      let r = await runTool(V2_LIST, args, meta(V2_LIST), c.env, c.executionCtx)
      if (r.status === 'invalid_args') {
        // v2 rejects the whole call on one unknown `fields` name (the model confuses filters or invented names for columns). Drop the names v2 lists and retry once.
        const bad = unknownFieldNames(r.message)
        if (bad.length) {
          args.fields = (args.fields as string[]).filter((f) => !bad.includes(f))
          r = await runTool(V2_LIST, args, meta(V2_LIST), c.env, c.executionCtx)
        }
      }
      if (r.status !== 'ok') return fail(failureMessage(r))
      // `hint` points at v2 tools this surface exposes under other names.
      const { hint: _hint, ...rest } = r.results as Record<string, unknown>
      const structured: Record<string, unknown> & { rows: Record<string, unknown>[] } = {
        ...rest,
        rows: (rest.rows as Record<string, unknown>[]).map(presentRow),
      }
      const n = structured.rows.length
      return ok({
        structuredContent: structured,
        content: [{
          type: 'text',
          text: `${n} of ${String(structured.total_matches)} matching accounts shown as cards. Do not list or restate the cards or write any links. Add analysis of what separates the options, using only fields in structuredContent.`,
        }],
      })
    }
    default:
      return err(-32601, `Method not found: ${method}`, 404)
  }
})

chatgpt.get('/mcp', (c) => c.text('Method Not Allowed', 405))

export default chatgpt
