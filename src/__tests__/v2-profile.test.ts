import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))

import app from '../index'
import { mockRedis, withSession } from './helpers'
import v2Manifest from '../../docs/v2-tool-manifest.json'
import legacyListGolden from './__golden__/legacy-tools-list.json?raw'

const V2_NAMES = ['list_business_checking', 'search_facts', 'fees_by_type', 'get_listing']
const LEGACY_NAMES = ['query_business_checking', 'get_business_checking_listing']

async function rpc(body: object, opts: { headers?: Record<string, string>; url?: string; env?: Record<string, string> } = {}) {
  const ctx = createExecutionContext()
  const res = await app.fetch(
    new Request(opts.url ?? 'http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
    }),
    { ...env, ...(opts.env ?? {}) },
    ctx
  )
  await waitOnExecutionContext(ctx)
  return res
}
const toolsList = (profile: 'legacy' | 'v2' | undefined, envOverride?: Record<string, string>) => {
  mockRedis({ sessionProfile: profile ?? 'none' })
  return rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: withSession(), env: envOverride })
}
const initialize = (opts: Parameters<typeof rpc>[1] = {}) =>
  rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, opts)

beforeEach(() => vi.clearAllMocks())

// Proves: the v2 manifest is the checked-in docs/v2-tool-manifest.json, is distinct from legacy, and fits the
// token budget (real tokens ~= chars / 2.16; measured 3,197 real tokens, budget = measured + ~3%).
describe('v2 tools/list', () => {
  it('a v2 session lists exactly the four v2 tools, deep-equal to docs/v2-tool-manifest.json', async () => {
    const res = await toolsList('v2')
    const body = await res.json<{ result: { tools: Array<{ name: string }> } }>()
    expect(body.result.tools.map((t) => t.name)).toEqual(V2_NAMES)
    expect(body.result).toEqual(v2Manifest)
  })

  it('schema budget: JSON.stringify(tools) <= 3,600 tokens (chars / 2.16)', async () => {
    const body = await (await toolsList('v2')).json<{ result: { tools: unknown[] } }>()
    expect(Math.ceil(JSON.stringify(body.result.tools).length / 2.16)).toBeLessThanOrEqual(3600)
  })

  it('v2 list schema uses rank_industries/rank_profiles (RANK ONLY) and no target_* names', async () => {
    const body = await (await toolsList('v2')).json<{ result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> } }> } }>()
    const props = body.result.tools[0]!.inputSchema.properties
    expect(props.rank_industries?.description).toMatch(/^RANK ONLY, never excludes/)
    expect(props.rank_profiles?.description).toMatch(/^RANK ONLY, never excludes/)
    expect(props.target_industries).toBeUndefined()
    expect(props.target_business_profiles).toBeUndefined()
  })

  it('keeps the apy_min unit hint (decimal) and never mentions affiliates', async () => {
    const result = (await (await toolsList('v2')).json<any>()).result
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual(V2_NAMES)
    const text = JSON.stringify(result)
    expect(text).toMatch(/decimal/)
    expect(text).not.toMatch(/affiliate|tracker/i)
  })

  it('differs from the legacy manifest', async () => {
    const v2 = await (await toolsList('v2')).text()
    const legacy = await (await toolsList('legacy')).text()
    expect(v2).not.toBe(legacy)
  })
})

// Proves: legacy tools/list is byte-identical to the golden captured before any code change.
describe('legacy tools/list', () => {
  it('a legacy session returns exactly the pre-change manifest, byte for byte', async () => {
    const body = await (await toolsList('legacy')).json<{ result: unknown }>()
    expect(JSON.stringify(body.result)).toBe(legacyListGolden)
    expect((body.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(LEGACY_NAMES)
  })
})

// Proves: the effective profile = session profile, else env MCP_PROFILE, else v2.
describe('profile selection at tools/list', () => {
  const names = async (res: Response) => (await res.json<{ result: { tools: Array<{ name: string }> } }>()).result.tools.map((t) => t.name)

  it('a session without a stored profile follows env MCP_PROFILE=v2', async () => {
    expect(await names(await toolsList(undefined, { MCP_PROFILE: 'v2' }))).toEqual(V2_NAMES)
  })
  it('a session without a stored profile and no env var is v2', async () => {
    expect(await names(await toolsList(undefined, { MCP_PROFILE: undefined as never }))).toEqual(V2_NAMES)
  })
  it('the stored session profile wins over the env default', async () => {
    expect(await names(await toolsList('legacy', { MCP_PROFILE: 'v2' }))).toEqual(LEGACY_NAMES)
    expect(await names(await toolsList('v2', { MCP_PROFILE: 'legacy' }))).toEqual(V2_NAMES)
  })
  it('/.well-known/mcp lists the env-default profile tools', async () => {
    const get = async (e: Record<string, string>) => {
      const res = await app.fetch(new Request('http://localhost/.well-known/mcp'), { ...env, ...e }, createExecutionContext())
      return (await res.json<{ tools: Array<{ name: string }> }>()).tools.map((t) => t.name)
    }
    expect(await get({ MCP_PROFILE: 'v2' })).toEqual(V2_NAMES)
    expect(await get({ MCP_PROFILE: 'legacy' })).toEqual(LEGACY_NAMES)
  })
})

// Proves: the profile is chosen once, at initialize, from the X-Bancadia-Profile header or ?profile=, falling
// back to env, and stored on the session record.
describe('profile override at initialize', () => {
  const storedProfile = (set: ReturnType<typeof vi.fn>) => (set.mock.calls[0]![1] as { profile?: string }).profile

  it('header X-Bancadia-Profile: v2 is stored on the session', async () => {
    const r = mockRedis()
    const res = await initialize({ headers: { 'X-Bancadia-Profile': 'v2' } })
    expect(res.status).toBe(200)
    expect(storedProfile(r.set)).toBe('v2')
  })

  it('is case-insensitive (V2) and accepts legacy over an env default of v2', async () => {
    const r1 = mockRedis()
    await initialize({ headers: { 'X-Bancadia-Profile': 'V2' } })
    expect(storedProfile(r1.set)).toBe('v2')
    const r2 = mockRedis()
    await initialize({ headers: { 'X-Bancadia-Profile': 'legacy' }, env: { MCP_PROFILE: 'v2' } })
    expect(storedProfile(r2.set)).toBe('legacy')
  })

  it('?profile=v2 on the MCP URL works, and the header wins over the query', async () => {
    const r1 = mockRedis()
    await initialize({ url: 'http://localhost/?profile=v2' })
    expect(storedProfile(r1.set)).toBe('v2')
    const r2 = mockRedis()
    await initialize({ url: 'http://localhost/?profile=v2', headers: { 'X-Bancadia-Profile': 'legacy' } })
    expect(storedProfile(r2.set)).toBe('legacy')
  })

  it('without an override the stored profile is the env default (v2 when MCP_PROFILE=v2 or unset)', async () => {
    const r1 = mockRedis()
    await initialize({ env: { MCP_PROFILE: 'v2' } })
    expect(storedProfile(r1.set)).toBe('v2')
    const r2 = mockRedis()
    await initialize({ env: { MCP_PROFILE: undefined as never } })
    expect(storedProfile(r2.set)).toBe('v2')
  })

  it('an unknown profile value is ignored (falls back to the env default)', async () => {
    const r = mockRedis()
    const res = await initialize({ headers: { 'X-Bancadia-Profile': 'beta' }, env: { MCP_PROFILE: 'legacy' } })
    expect(res.status).toBe(200)
    expect(storedProfile(r.set)).toBe('legacy')
  })

  it('the initialize response itself is unchanged (no profile leaked into serverInfo)', async () => {
    mockRedis()
    const body = await (await initialize({ headers: { 'X-Bancadia-Profile': 'v2' } })).json<{ result: Record<string, unknown> }>()
    expect(Object.keys(body.result).sort()).toEqual(['capabilities', 'protocolVersion', 'serverInfo'])
  })
})
