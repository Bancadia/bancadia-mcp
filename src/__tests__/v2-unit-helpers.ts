// Helpers for the mocked-Supabase v2 unit suites. Each test file must declare the hoisted
// vi.mock('@upstash/redis'), vi.mock('@upstash/ratelimit') and vi.mock('../lib/supabase') itself.
import { vi } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import app from '../index'
import { createSupabaseClient } from '../lib/supabase'
import { mockRedis, mockAnalyticsTables, withSession } from './helpers'

type RpcResult = { data?: unknown; error?: { message: string; code?: string } | null }
export type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

// Fake Supabase: rpc(name, args) answered from `responses[name]`; analytics tables recorded.
export function setupDb(responses: Record<string, RpcResult>) {
  const tables = mockAnalyticsTables({})
  const rpc = vi.fn(async (name: string) => {
    const r = responses[name]
    if (!r) throw new Error(`unexpected rpc ${name}`)
    return { data: r.data ?? null, error: r.error ?? null }
  })
  vi.mocked(createSupabaseClient).mockReturnValue({ rpc, from: tables.from } as never)
  return { rpc, ...tables }
}

export async function callMcp(
  name: string,
  args: Record<string, unknown> = {},
  opts: { profile?: 'legacy' | 'v2'; envOverride?: Record<string, string> } = {}
) {
  mockRedis({ tokenValid: true, tokenDeveloperId: null, sessionProfile: opts.profile ?? 'v2' })
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk_test_token', ...withSession({ 'Mcp-Session-Id': '11111111-1111-4111-8111-111111111111' }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    { ...env, ...(opts.envOverride ?? {}) },
    ctx
  )
  await waitOnExecutionContext(ctx)
  const body = (await res.json()) as Json
  if (body.error) return { ok: false as const, code: body.error.code as number, message: String(body.error.message), status: res.status }
  const text = body.result.content[0].text as string
  return { ok: true as const, data: JSON.parse(text) as Json, text, status: res.status }
}

export async function callRest(path: string) {
  mockRedis({ tokenValid: true, tokenDeveloperId: null })
  const ctx = createExecutionContext()
  const res = await app.fetch(new Request(`http://localhost/v1${path}`), env, ctx)
  await waitOnExecutionContext(ctx)
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text) as Json, text, requestId: res.headers.get('X-Request-Id') ?? '' }
}

// What the DB functions return (shapes from bancadia-db/plans/mcp-db-contract.md), with relative application_urls.
export const row = (slug: string, extra: Json = {}) => ({ listing_slug: slug, application_url: `/go/${slug}/checking`, institution_name: slug.toUpperCase(), ...extra })
export const listPayload = (over: Json = {}) => ({
  rows: [row('a-bank'), row('b-bank')],
  total_matches: 5, returned: 2, limit: 2, next_offset: 2, excluded_by: {},
  matches_overview: ['a-bank', 'b-bank', 'c-bank', 'd-bank', 'e-bank'].map((slug) => ({ slug, name: slug.toUpperCase() })),
  returned_ids: [{ id: 'id-a', rank: 3, slug: 'a-bank' }, { id: 'id-b', rank: 4, slug: 'b-bank' }],
  ...over,
})
export const factsPayload = () => ({
  hits: [{ slug: 'a-bank', name: 'A', application_url: '/go/a/checking', facts: [{ topic: 'fees', snippet: 's', plan: 'all plans' }] }],
  no_match: [{ slug: 'b-bank', name: 'B', application_url: '/go/b/checking' }],
  scanned: 2, banks_matched: 1,
  returned_ids: [{ id: 'id-a', rank: 1, slug: 'a-bank' }],
})
export const feesPayload = () => ({
  results: [{ slug: 'a-bank', name: 'A', application_url: '/go/a/checking', fees: [{ fee_type: 'cash_deposit', plan: 'all plans', amount: 2 }] }],
  returned_ids: [{ id: 'id-a', rank: 1, slug: 'a-bank' }],
})
export const listingPayload = () => ({
  listings: [{ slug: 'a-bank', application_url: '/go/a/checking', detail_has: ['fees:1'], fees: [{ fee_type: 'cash_deposit', plan: 'all plans', amount: 2 }] }],
  not_found: ['zzz'],
  returned_ids: [{ id: 'id-a', rank: 1, slug: 'a-bank' }],
})
