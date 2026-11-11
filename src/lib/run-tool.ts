import type { Env } from '../types'
import { TOOLS } from './tools'
import { TOOLS_V2, V2_TOOL_NAMES } from './tools-v2'
import type { Profile } from './profile'
import { normalizeArgs, validateStates } from './normalize-args'
import { mapDbError } from './db-errors'
import { tagResponse } from './tag-response'
import { V2_HANDLERS } from '../handlers/v2'
import { validateArgs } from './validate-args'
import { applyApplicationUrlHost } from './urls'
import { recordQueryEvent, type QueryMeta } from './analytics'
import { handleQueryBusinessChecking } from '../handlers/query-business-checking'
import { handleGetBusinessCheckingListing } from '../handlers/get-business-checking-listing'

type ToolHandler = (
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
  meta: QueryMeta
) => Promise<object[]>

const toolHandlers: Record<string, ToolHandler> = {
  query_business_checking: handleQueryBusinessChecking,
  get_business_checking_listing: handleGetBusinessCheckingListing,
}

export type RunToolResult =
  | { status: 'ok'; results: object }
  | { status: 'invalid_args'; message: string }
  | { status: 'error' }

// Client-facing text for a failed run, shared by MCP, REST and ChatGPT (each maps it to its own error shape).
export const failureMessage = (r: Exclude<RunToolResult, { status: 'ok' }>): string =>
  r.status === 'invalid_args' ? r.message : 'Internal error while querying listings. Please retry.'

export const isKnownTool = (name: string, profile: Profile = 'legacy'): boolean =>
  profile === 'v2' ? V2_TOOL_NAMES.has(name) : name in toolHandlers

const LIST_NOTES =
  'Absent field = not offered or not published; true with no amount = offered, amount not published. Use fields to select more columns.'
const PROMO_NOTE = ' Promotions are recorded for only some banks; no promotion listed may mean not recorded.'
const LIST_HINT = 'Free-text fee and feature details are searchable: call search_facts(query, slugs) or get_listing(slugs, sections).'

type Payload = any // eslint-disable-line @typescript-eslint/no-explicit-any

// v2 pipeline: validate, normalize, rpc, map errors, strip internals, tag + assert, log.
async function runV2(
  name: string,
  args: Record<string, unknown>,
  meta: QueryMeta,
  env: Env,
  ctx: ExecutionContext
): Promise<RunToolResult> {
  const reject = (message: string): RunToolResult => {
    ctx.waitUntil(recordQueryEvent(env, meta, args, { status: 'invalid_args', errorMessage: message }))
    return { status: 'invalid_args', message }
  }
  const fail = (err: unknown): RunToolResult => {
    console.error(`${meta.channel} ${name} failed (request_id=${meta.requestId})`, err)
    ctx.waitUntil(
      recordQueryEvent(env, meta, args, { status: 'error', errorMessage: err instanceof Error ? err.message : String(err) })
    )
    return { status: 'error' }
  }

  const invalid = validateArgs(args, TOOLS_V2.find((t) => t.name === name)!.inputSchema)
  if (invalid) return reject(invalid)
  const norm = normalizeArgs(name, args)
  const badState = validateStates(norm)
  if (badState) return reject(badState)

  try {
    const { data, error } = await V2_HANDLERS[name]!(norm, env)
    if (error) {
      const m = mapDbError(error)
      if (m.kind === 'invalid_args') return reject(m.message)
      return fail(new Error(`${error.code ?? ''} ${error.message}`))
    }
    const { returned_ids, ...rest } = data as Payload
    let payload: Payload = name === 'fees_by_type' ? rest.results : rest
    if (name === 'list_business_checking') {
      payload = { ...payload, notes: norm.has_active_promotion === undefined ? LIST_NOTES : LIST_NOTES + PROMO_NOTE, ...(payload.rows.length > 0 ? { hint: LIST_HINT } : {}) }
    }
    payload = tagResponse(name, payload, { src: meta.channel, qr: meta.requestId })

    const count = ({ list_business_checking: payload.rows, search_facts: payload.hits, get_listing: payload.listings }[name] ?? payload).length
    const isList = name === 'list_business_checking'
    ctx.waitUntil(
      recordQueryEvent(env, meta, args, {
        status: 'ok',
        matches: ((returned_ids ?? []) as Array<{ id: string; slug: string; rank: number }>).map((r) => ({
          listingId: r.id, institutionId: null, listingSlug: r.slug, rank: r.rank,
        })),
        v2: {
          total_matches: name === 'search_facts' ? payload.banks_matched : isList ? payload.total_matches : count,
          offset: isList ? Math.max((norm.offset as number | undefined) ?? 0, 0) : null,
          fields: isList ? ((norm.fields as string[] | undefined) ?? null) : null,
        },
      })
    )
    return { status: 'ok', results: payload }
  } catch (err) {
    return fail(err)
  }
}

// Shared by MCP tools/call and REST: validate against the tool's schema, run
// the handler, tag application_url (src = meta.channel, qr = meta.requestId),
// and log rejected/failed calls. The raw error stays in Worker logs only.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  meta: QueryMeta,
  env: Env,
  ctx: ExecutionContext
): Promise<RunToolResult> {
  if (V2_TOOL_NAMES.has(name)) return runV2(name, args, meta, env, ctx)
  const invalid = validateArgs(args, TOOLS.find((t) => t.name === name)!.inputSchema)
  if (invalid) {
    ctx.waitUntil(recordQueryEvent(env, meta, args, { status: 'invalid_args', errorMessage: invalid }))
    return { status: 'invalid_args', message: invalid }
  }
  try {
    const results = await toolHandlers[name]!(args, env, ctx, meta)
    return { status: 'ok', results: applyApplicationUrlHost(results, { src: meta.channel, qr: meta.requestId }) }
  } catch (err) {
    console.error(`${meta.channel} ${name} failed (request_id=${meta.requestId})`, err)
    ctx.waitUntil(
      recordQueryEvent(env, meta, args, {
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    )
    return { status: 'error' }
  }
}
