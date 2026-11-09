// Shared by the v2 integration suites (real local Supabase). Each test file must itself declare the
// hoisted `vi.mock('@upstash/redis')` / `vi.mock('@upstash/ratelimit')` preamble (see v2-paging.integration.test.ts).
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import app from '../../index'
import { mockRedis, withSession } from '../helpers'
import { realSupabase } from './db-helpers'
import { KNOWN_SLUGS } from './fixtures'

export type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
export const db = realSupabase()
export const K = KNOWN_SLUGS
// approximation from docs/v2-tool-spec.md section 8
export const approxTokens = (s: string) => Math.ceil(s.length / 2.6)

export type McpResult =
  | { ok: true; data: Json; text: string; status: number }
  | { ok: false; code: number; message: string; status: number }

// One MCP tools/call through the real app. `profile` is stored on the (mocked) session record,
// exactly where the Worker is specified to read it (spec section 1).
export async function mcp(
  name: string,
  args: Record<string, unknown> = {},
  opts: { sessionId?: string; profile?: 'legacy' | 'v2'; envOverride?: Record<string, string> } = {}
): Promise<McpResult> {
  mockRedis({ tokenValid: true, tokenDeveloperId: null, sessionProfile: opts.profile ?? 'v2' })
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk_test_token',
        ...withSession({ 'Mcp-Session-Id': opts.sessionId ?? crypto.randomUUID() }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    { ...env, ...(opts.envOverride ?? {}) },
    ctx
  )
  await waitOnExecutionContext(ctx) // flush ctx.waitUntil(recordQueryEvent(...))
  const body = (await res.json()) as Json
  if (body.error) return { ok: false, code: body.error.code, message: String(body.error.message), status: res.status }
  const text = body.result.content[0].text as string
  return { ok: true, data: JSON.parse(text), text, status: res.status }
}

export async function mcpOk(name: string, args: Record<string, unknown> = {}, opts: Parameters<typeof mcp>[2] = {}) {
  const r = await mcp(name, args, opts)
  if (!r.ok) throw new Error(`${name} failed: [${r.code}] ${r.message}`)
  return r
}

export async function mcpErr(name: string, args: Record<string, unknown>, opts: Parameters<typeof mcp>[2] = {}) {
  const r = await mcp(name, args, opts)
  if (r.ok) throw new Error(`${name} unexpectedly succeeded: ${r.text.slice(0, 200)}`)
  return r
}

export async function rest(path: string, headers: Record<string, string> = {}) {
  mockRedis({ tokenValid: true, tokenDeveloperId: null })
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { headers }), env, ctx)
  await waitOnExecutionContext(ctx)
  const text = await res.text()
  let body: Json = null
  try {
    body = JSON.parse(text)
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, text, requestId: res.headers.get('X-Request-Id') ?? '', headers: res.headers }
}

// ---- direct DB (the DB functions and tables are the oracle) ----
export async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn as never, args as never)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as Json
}

export async function activeListings() {
  const { data, error } = await db
    .from('business_deposit_accounts')
    .select('id, listing_slug, monthly_fee, is_affiliate_tracked')
    .eq('listing_status', 'active')
    .eq('product_type', 'checking')
  if (error) throw new Error(error.message)
  return data as Array<{ id: string; listing_slug: string; monthly_fee: number; is_affiliate_tracked: boolean }>
}

// affiliate-tracked first, then monthly fee, then id (spec: DB sort precedence without sort/rank)
export async function defaultOrderSlugs(filter: (l: Awaited<ReturnType<typeof activeListings>>[number]) => boolean = () => true) {
  return (await activeListings())
    .filter(filter)
    .sort(
      (a, b) =>
        Number(b.is_affiliate_tracked) - Number(a.is_affiliate_tracked) ||
        a.monthly_fee - b.monthly_fee ||
        (a.id < b.id ? -1 : 1)
    )
    .map((l) => l.listing_slug)
}

export async function eventsFor(sessionId: string) {
  const { data, error } = await db
    .from('query_events')
    .select('*, query_match_events(listing_slug, listing_id, result_rank)')
    .eq('session_id', sessionId)
  if (error) throw new Error(error.message)
  return data as Json[]
}

// ---- response inspection ----
export function deepKeys(v: Json, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out))
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.push(k)
      deepKeys(x, out)
    }
  return out
}
export const affiliateKeys = (v: Json) => deepKeys(v).filter((k) => /^(is_affiliate|tracker_url|affiliate_)/.test(k))

// Bank-bearing rows per tool (spec section 4). matches_overview / possible_matches are NOT bank-bearing.
export function bankRows(tool: string, payload: Json): Json[] {
  switch (tool) {
    case 'list_business_checking': return payload.rows ?? []
    case 'search_facts': return [...(payload.hits ?? []), ...(payload.no_match ?? [])]
    case 'fees_by_type': return Array.isArray(payload) ? payload : payload.results ?? []
    case 'get_listing': return payload.listings ?? []
    default: throw new Error(`unknown tool ${tool}`)
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function expectTaggedUrl(url: unknown, src: 'mcp' | 'rest'): string {
  if (typeof url !== 'string') throw new Error(`application_url missing or not a string: ${String(url)}`)
  const u = new URL(url) // throws if relative
  const problems: string[] = []
  if (u.origin !== 'https://bancadia.com') problems.push(`origin ${u.origin}`)
  if (!u.pathname.startsWith('/go/')) problems.push(`path ${u.pathname}`)
  if (u.searchParams.get('src') !== src) problems.push(`src=${u.searchParams.get('src')}`)
  if (!UUID.test(u.searchParams.get('qr') ?? '')) problems.push(`qr=${u.searchParams.get('qr')}`)
  if (problems.length) throw new Error(`bad application_url ${url}: ${problems.join(', ')}`)
  return u.searchParams.get('qr')!
}

// The same JSON the DB function returns, minus internals, for deep comparison with what the Worker returned.
export const stripInternal = ({ returned_ids, ...rest }: Json) => rest
