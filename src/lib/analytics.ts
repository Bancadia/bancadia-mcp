import { createSupabaseClient } from './supabase'
import type { Env } from '../types'
import type { Json } from './database.types'

export type QueryMeta = {
  toolName: string
  developerId: string | null
  sessionId: string
}

export type MatchedListing = {
  listingId: string
  institutionId: string
  listingSlug: string | null
}

// Fire-and-forget: writes one query_match_events row per listing a tool call
// returned. Callers pass the result to ctx.waitUntil() rather than awaiting
// it directly, so this never adds latency to the tools/call response — and
// any failure here must never surface to the client, hence the blanket catch.
export async function recordMatchEvents(
  env: Env,
  meta: QueryMeta,
  args: Record<string, unknown>,
  matches: MatchedListing[]
): Promise<void> {
  if (matches.length === 0) return

  try {
    const requestId = crypto.randomUUID()
    const rows = matches.map((match, index) => ({
      listing_id: match.listingId,
      institution_id: match.institutionId,
      listing_slug: match.listingSlug,
      tool_name: meta.toolName,
      developer_id: meta.developerId,
      session_id: meta.sessionId,
      request_id: requestId,
      result_rank: index + 1,
      result_count: matches.length,
      query_filters: args as Json,
    }))

    await createSupabaseClient(env).from('query_match_events').insert(rows)
  } catch {
    // best-effort analytics; never let a failure here affect the client response
  }
}
