import { createSupabaseClient } from './supabase'
import type { Env } from '../types'
import type { Json } from './database.types'
import { profileOfTool } from './tools-v2'

export type QueryMeta = {
  toolName: string
  developerId: string | null
  channel: 'mcp' | 'rest' | 'chatgpt'
  sessionId: string | null // null for REST and chatgpt (stateless)
  userAgent: string | null
  // Generated once per tools/call in index.ts. Written as
  // query_events.request_id (and on that call's query_match_events rows) AND
  // appended as `qr` to each returned application_url, so a /go click can be
  // joined back to the exact tool call that surfaced the link.
  requestId: string
  // Chatbot host's conversation id (ChatGPT: _meta["openai/session"]) -> query_events.chat_conversation_id.
  // Omitted from the insert when unset so the row shape for every other call is unchanged.
  chatConversationId?: string | null
}

export type MatchedListing = {
  listingId: string
  institutionId: string | null
  listingSlug: string | null
  rank?: number // global rank (v2); defaults to position + 1
}

// v2-only columns of the query_events row.
export type V2EventColumns = { total_matches: number | null; offset: number | null; fields: string[] | null }

// 'ok' covers zero-result calls too (matches: []) — those are the calls worth
// finding, since they show what agents ask for that the registry can't satisfy.
export type QueryOutcome =
  | { status: 'ok'; matches: MatchedListing[]; v2?: V2EventColumns }
  | { status: 'invalid_args' | 'error'; errorMessage: string }

const MAX_ERROR_MESSAGE_LENGTH = 1000

// Fire-and-forget: writes one query_events row for the call, then (for an 'ok'
// call with results) one query_match_events row per returned listing. Callers
// pass the result to ctx.waitUntil() rather than awaiting it directly, so this
// never adds latency to the tools/call response — and any failure here must
// never surface to the client, hence the blanket catch.
export async function recordQueryEvent(
  env: Env,
  meta: QueryMeta,
  args: Record<string, unknown>,
  outcome: QueryOutcome
): Promise<void> {
  try {
    const supabase = createSupabaseClient(env)

    const { error } = await supabase.from('query_events').insert({
      request_id: meta.requestId,
      tool_name: meta.toolName,
      session_id: meta.sessionId,
      channel: meta.channel,
      user_agent: meta.userAgent?.slice(0, 512) ?? null,
      developer_id: meta.developerId,
      ...(meta.chatConversationId ? { chat_conversation_id: meta.chatConversationId } : {}),
      query_filters: args as Json,
      status: outcome.status,
      profile: profileOfTool(meta.toolName),
      ...(outcome.status === 'ok' ? outcome.v2 : {}),
      result_count: outcome.status === 'ok' ? outcome.matches.length : null,
      error_message: outcome.status === 'ok' ? null : outcome.errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    })
    // Match rows FK to query_events.request_id, so they can't land without it.
    if (error || outcome.status !== 'ok' || outcome.matches.length === 0) return

    await supabase.from('query_match_events').insert(
      outcome.matches.map((match, index) => ({
        request_id: meta.requestId,
        listing_id: match.listingId,
        institution_id: match.institutionId,
        listing_slug: match.listingSlug,
        result_rank: match.rank ?? index + 1,
      }))
    )
  } catch {
    // best-effort analytics; never let a failure here affect the client response
  }
}
