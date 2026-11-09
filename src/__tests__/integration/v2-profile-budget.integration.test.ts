import { describe, it, expect, vi } from 'vitest'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }) }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})
// No vi.mock('../../lib/supabase'): real local Supabase, like the sibling suites.

import { mcp, mcpOk } from './v2-helpers'
import { normalizeForGolden, CANNED_LIST_QUERIES, CANNED_GET_SLUGS } from '../golden-normalize'
import legacyOutputs from '../__golden__/legacy-tool-outputs.json'
import v2Manifest from '../../../docs/v2-tool-manifest.json'


const approx = (s: string) => Math.ceil(s.length / 2.16)

// Proves: the legacy profile still returns exactly what it returned before the v2 work (goldens captured on the
// pre-change code against this seed; normalized only for timestamps, qr ids and array order). These pass today
// and must keep passing: they are the regression guard for the A/B benchmark.
describe('legacy profile is unchanged (golden snapshots)', () => {
  it.each(Object.keys(CANNED_LIST_QUERIES))('query_business_checking %s equals its golden', async (name) => {
    const r = await mcpOk('query_business_checking', CANNED_LIST_QUERIES[name]!, { profile: 'legacy' })
    expect(normalizeForGolden(r.data)).toEqual((legacyOutputs as Record<string, unknown>)[`query:${name}`])
  })

  it.each(CANNED_GET_SLUGS)('get_business_checking_listing %s equals its golden', async (slug) => {
    const r = await mcpOk('get_business_checking_listing', { listing_slug: slug }, { profile: 'legacy' })
    expect(normalizeForGolden(r.data)).toEqual((legacyOutputs as Record<string, unknown>)[`get:${slug}`])
  })

  it('legacy list output is still a bare array without v2 keys (no total_matches, no matches_overview)', async () => {
    const r = await mcpOk('query_business_checking', {}, { profile: 'legacy' })
    expect(Array.isArray(r.data)).toBe(true)
    expect(r.data.length).toBe(13)
  })
})

// Proves: the v2 profile exposes the v2 tools and only them, and a tool of the other profile is unknown.
describe('profile gating of tools/call', () => {
  it('v2 session: legacy tool names are unknown (-32601)', async () => {
    const r = await mcp('query_business_checking', {}, { profile: 'v2' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe(-32601)
  })
  it('legacy session: v2 tool names are unknown (-32601)', async () => {
    const r = await mcp('list_business_checking', {}, { profile: 'legacy' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe(-32601)
  })
  it('a session without a stored profile follows env MCP_PROFILE', async () => {
    // mcp() always stores a profile, so go through the env path by overriding the stored one with undefined
    const r = await mcp('list_business_checking', {}, { profile: undefined as never, envOverride: { MCP_PROFILE: 'v2' } })
    expect(r.ok).toBe(true)
  })
})

// Proves: the token budgets from docs/v2-tool-spec.md section 8 hold on real data (real tokens ~= chars / 2.16).
describe('v2 token budgets', () => {
  it('default list response (7 rows, tagged, as sent over MCP) is <= 5,000 tokens', async () => {
    const r = await mcpOk('list_business_checking', {})
    expect(r.data.rows).toHaveLength(7)
    expect(approx(r.text)).toBeLessThanOrEqual(5000)
  })

  it('the 20-row response is still bounded (<= 2x the default budget)', async () => {
    const r = await mcpOk('list_business_checking', { limit: 20 })
    expect(approx(r.text)).toBeLessThanOrEqual(10000)
  })

  it('the checked-in manifest itself is within the 3,400 token schema budget', () => {
    expect(approx(JSON.stringify(v2Manifest.tools))).toBeLessThanOrEqual(3400)
  })
})
