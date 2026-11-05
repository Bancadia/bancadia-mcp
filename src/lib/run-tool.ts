import type { Env } from '../types'
import { TOOLS } from './tools'
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
  | { status: 'ok'; results: object[] }
  | { status: 'invalid_args'; message: string }
  | { status: 'error' }

export const isKnownTool = (name: string): boolean => name in toolHandlers

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
