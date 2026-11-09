import { createSupabaseClient } from '../lib/supabase'
import type { Env } from '../types'

export type RpcResult = { data: unknown; error: { message: string; code?: string } | null }
type Args = Record<string, unknown>

const rpc = (env: Env, fn: string, params: Args): Promise<RpcResult> =>
  createSupabaseClient(env).rpc(fn as never, params as never) as unknown as Promise<RpcResult>

// Tool arguments that are not filters, and the two renamed rank args.
const NOT_FILTERS = new Set(['fields', 'limit', 'offset'])
const RENAME: Record<string, string> = { rank_industries: 'target_industries', rank_profiles: 'target_business_profiles' }

// Undefined params are dropped by JSON serialization, so the DB defaults apply.
export const V2_HANDLERS: Record<string, (args: Args, env: Env) => Promise<RpcResult>> = {
  list_business_checking: (a, env) =>
    rpc(env, 'list_business_checking', {
      p_filters: Object.fromEntries(Object.entries(a).filter(([k]) => !NOT_FILTERS.has(k)).map(([k, v]) => [RENAME[k] ?? k, v])),
      p_fields: a.fields,
      p_limit: a.limit,
      p_offset: a.offset,
    }),
  search_facts: (a, env) =>
    rpc(env, 'search_listing_facts', {
      p_query: a.query, p_slugs: a.slugs, p_topic: a.topic, p_per_bank: a.per_bank, p_max_banks: a.max_banks, p_max_chars: a.max_chars,
    }),
  fees_by_type: (a, env) => rpc(env, 'fees_by_type', { p_fee_types: a.fee_types, p_slugs: a.slugs, p_plan: a.plan }),
  get_listing: (a, env) => rpc(env, 'get_listing_sections', { p_slugs: a.slugs, p_sections: a.sections, p_query: a.query }),
}
