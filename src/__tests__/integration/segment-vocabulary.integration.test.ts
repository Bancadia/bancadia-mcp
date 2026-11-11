import { describe, it, expect, vi } from 'vitest'

vi.mock('@upstash/redis', () => ({ Redis: vi.fn() }))
vi.mock('@upstash/ratelimit', () => {
  const RatelimitMock = vi.fn(function () {
    return { limit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: Date.now() + 60000 }) }
  }) as unknown as { new (...args: unknown[]): unknown; slidingWindow: ReturnType<typeof vi.fn> }
  RatelimitMock.slidingWindow = vi.fn().mockReturnValue({})
  return { Ratelimit: RatelimitMock }
})
// No vi.mock('../../lib/supabase'): real Supabase, like the sibling suites.

import { mcpErr } from './v2-helpers'
import v2Manifest from '../../../docs/v2-tool-manifest.json'

// Proves: the segment values named in rank_industries / rank_profiles (the manifest, so MCP, ChatGPT and the REST
// OpenAPI doc) are exactly the database's target_segment_enum. The DB's own "Valid target segments" error is the
// authoritative list, so adding or renaming an enum value fails here until the manifest is updated.
describe('rank_industries / rank_profiles vocabularies match target_segment_enum', () => {
  it('every enum value is named, and nothing else is', async () => {
    const err = await mcpErr('list_business_checking', { rank_industries: ['zz_not_a_segment'] })
    const valid = /Valid target segments: ([^]+)$/.exec(err.message)?.[1]?.split(',').map((v) => v.trim()).filter(Boolean)
    expect(valid, `unexpected error text: ${err.message}`).toBeTruthy()

    const props = v2Manifest.tools.find((t) => t.name === 'list_business_checking')!.inputSchema.properties as Record<string, { description: string }>
    // Each description ends with "Values: a, b, c": that list is what the model is told.
    const named = ['rank_industries', 'rank_profiles'].flatMap((k) => {
      const list = /Values: ([^]+)$/.exec(props[k]!.description)?.[1]
      expect(list, `${k} description must end with "Values: ..."`).toBeTruthy()
      return list!.split(',').map((v) => v.trim()).filter(Boolean)
    })
    expect({
      add_to_manifest_descriptions: valid!.filter((v) => !named.includes(v)),
      remove_from_manifest_descriptions: named.filter((v) => !valid!.includes(v)),
    }).toEqual({ add_to_manifest_descriptions: [], remove_from_manifest_descriptions: [] })
  })
})
