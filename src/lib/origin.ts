import type { Env } from '../types'

// DNS-rebinding guard for the Streamable HTTP transport. Non-browser MCP
// clients (Claude Desktop, Claude Code, server-side SDKs, curl) don't send
// an Origin header at all, so those are allowed through unconditionally.
// Requests that do carry an Origin header (i.e. browser-based callers) are
// only allowed if that origin is in the ALLOWED_ORIGINS allowlist.
export function validateOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) {
    return true
  }

  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  return allowed.includes(origin)
}
