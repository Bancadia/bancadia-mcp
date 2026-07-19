# Spec: Upgrade bancadia-mcp to the MCP Streamable HTTP Transport

## Context

Bancadia MCP (`mcp.bancadia.com`) currently speaks JSON-RPC 2.0 over a single
`POST /` endpoint, but it does not implement either of the transports defined
by the Model Context Protocol spec (neither the legacy HTTP+SSE transport nor
the current "Streamable HTTP" transport). It's a simplified single-request /
single-JSON-response HTTP API that happens to use the JSON-RPC message
format.

This matters for two reasons:

1. **Real MCP client libraries won't reliably work against it.** Clients
   built on the official `@modelcontextprotocol/sdk` (or the MCP client
   embedded in Claude Code, Claude Desktop, and third-party developer
   tooling) are written against the spec'd transports — they may attempt
   session negotiation, send an `Accept: text/event-stream` header expecting
   the option of a streamed response, or open a standalone GET/SSE
   connection. Our server doesn't support any of that today.
2. **This is the actual product test.** Bancadia MCP's value proposition to
   third-party developers is "connect your MCP client and it works." A
   from-scratch, spec-compliant transport implementation is a stronger proof
   of that than wiring the internal chat widget up to a client shim — the
   chat integration has been intentionally deferred (see Non-goals below).

This document describes the target end state and constraints for
implementing the upgrade. It does not prescribe the internal implementation
plan — that's for the implementing agent to design, informed by the open
questions in this doc.

## Goal

Bring `bancadia-mcp`'s HTTP transport into full conformance with the MCP
**Streamable HTTP transport**, as defined at
https://modelcontextprotocol.io/specification/2025-06-18/basic/transports,
including:

- Content negotiation and the optional SSE response mode on `POST`
- Session handling (`Mcp-Session-Id`) from `initialize` onward
- The optional standalone `GET` SSE stream for server-initiated messages
- Session termination via `DELETE`
- The security requirements the spec calls out for this transport

The result should be a server that an unmodified, off-the-shelf MCP client
library can connect to, initialize a session with, list tools on, and call
tools on — with no bancadia-specific client workarounds required.

## Non-goals

- **No chat feature integration.** `bancadia-app`'s chat route is not part of
  this work and should not be touched. That integration is deliberately
  deferred until this transport upgrade lands.
- **No new tools.** Do not wire up `query_personal_savings` or any of the
  other dormant handler modules in `src/handlers/`. Bancadia's current
  catalog has no personal deposit account products, so those tools stay
  unregistered. Scope is the transport layer only, not the tool surface.
- **No change to the auth model.** `tools/call` continues to require a
  bearer token validated against `developer_api_tokens` exactly as it does
  today (`src/lib/auth.ts`). `initialize` and `tools/list` remain
  unauthenticated, as they are now. Session handling is layered on top of
  this existing auth flow, not a replacement for it.
- **No requirement to preserve the exact current wire behavior of simple
  clients.** Per spec, a server is allowed to respond to a `POST` containing
  a request with a plain `application/json` body instead of upgrading to SSE.
  As long as that mode is supported, existing simple JSON-RPC callers (e.g.
  a developer hitting the endpoint with `curl`) keep working without change.
  Do not treat "don't break the current curl-style flow" as a reason to skip
  implementing the SSE mode — both response modes must coexist per spec.

## Current implementation (for reference)

All routing lives in `src/index.ts` (a single-file Hono router):

- `GET /health` — trivial liveness check.
- `GET /.well-known/mcp` — public discovery document listing available tools.
- `POST /` — the entire JSON-RPC 2.0 surface:
  - Requests with `id === undefined` (notifications) get an empty `202`.
  - `initialize` — negotiates a protocol version from
    `SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']`
    (index.ts:15), no auth, no session ID is issued or expected.
  - `tools/list` — no auth, returns `getToolManifest()` from `src/lib/tools.ts`.
  - `tools/call` — runs `authenticate()` (`src/lib/auth.ts`), then a per-token
    Upstash sliding-window rate limit (`src/index.ts:90-114`), then dispatches
    through a hardcoded `toolHandlers` map (currently only
    `query_business_checking`), and returns the result as a single JSON body:
    `{ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results) }] } }`.
  - Every response — success or error — is a single `application/json` body.
    There is no SSE anywhere in the codebase, no `Mcp-Session-Id` handling,
    and no `GET`/`DELETE` support on `/`.

`authenticate()` (`src/lib/auth.ts`) hashes the bearer token (SHA-256), checks
an Upstash Redis cache keyed `token:<hash>`, and falls back to a Supabase
lookup against `developer_api_tokens` on a cache miss, caching the result back
into Redis with a 60s TTL via `ctx.waitUntil()`.

The Worker is deployed via `wrangler.toml`: `staging` (`workers.dev` enabled)
and `production` (routed at `mcp.bancadia.com/*`, `workers.dev` disabled).
`compatibility_flags = ["nodejs_compat"]` is already set.

## Target behavior

### 1. Endpoint shape

The MCP endpoint (currently `/`) must accept `POST`, `GET`, and `DELETE`.
Keep `GET /health` and `GET /.well-known/mcp` as they are — they're not part
of the MCP transport itself.

### 2. `POST` — content negotiation and response mode

- Client requests to the MCP endpoint will send
  `Accept: application/json, text/event-stream`. The server must handle this.
- For a request body containing only responses/notifications (no request
  awaiting a reply), continue returning `202` with no body, as today.
- For a request body containing a JSON-RPC **request** (`initialize`,
  `tools/list`, `tools/call`), the server may respond in either mode, chosen
  per-request:
  - **Plain JSON mode** (`Content-Type: application/json`): a single
    JSON-RPC response object, exactly as today. This is the correct mode for
    fast, single-shot calls like `initialize`, `tools/list`, and the current
    `tools/call` (none of our tool handlers emit progress notifications
    today, so there's no inherent need to stream tool call responses).
  - **SSE mode** (`Content-Type: text/event-stream`): opens a stream on the
    same POST response over which the server can send zero or more
    intermediate JSON-RPC messages (e.g. `notifications/progress`) before
    sending the final JSON-RPC response as the last event, then closing the
    stream.
  - Both modes must be implemented and spec-conformant even though no
    current tool needs progress notifications — a compliant client may
    choose to always negotiate for `text/event-stream` and the server must
    handle that gracefully rather than only supporting the plain-JSON path.

### 3. `GET` — standalone SSE stream (optional per spec, required here)

- Per spec this is optional, but the requirement here is to implement it so
  that clients which unconditionally open it after `initialize` don't fail.
- A `GET` request with `Accept: text/event-stream` opens a long-lived SSE
  stream for server-initiated messages not tied to a specific `POST` (e.g.
  future sampling requests, notifications). Given the current tool surface
  has no server-initiated messages to send, this can be a minimal
  spec-compliant stream that stays open (with keep-alives as needed) rather
  than a fully-featured push channel — but it must be present and correctly
  negotiate session/`Origin` handling like any other request.
- If, after investigation, keeping such a stream open is impractical in the
  Workers runtime (see Open Questions), the server may reject `GET` with
  `405 Method Not Allowed` per spec — but this decision should be made
  deliberately and documented, not by omission.

### 4. Session management

- On a successful `initialize`, the server must issue an `Mcp-Session-Id`
  header on the HTTP response carrying the `InitializeResult`.
- Every subsequent request from that client (`tools/list`, `tools/call`,
  the standalone `GET`, and `DELETE`) must include that same
  `Mcp-Session-Id` header.
- The server must validate the session ID on every request after
  `initialize`:
  - Missing/invalid/expired session ID → reject appropriately (per spec,
    `404` for a request referencing a session the server no longer
    recognizes, prompting the client to re-`initialize`).
- Support client-initiated termination: a `DELETE` request carrying
  `Mcp-Session-Id` should end that session server-side.
- **Storage**: Cloudflare Workers isolates are stateless between requests
  (this is already called out in `CLAUDE.md` re: `createSupabaseClient()`
  being a per-request factory, not a singleton). Session state cannot live
  in memory — it needs to be persisted somewhere shared across requests/
  isolates. Upstash Redis is already a dependency used for auth caching and
  rate limiting (`src/lib/auth.ts`, `src/index.ts`) and is the natural place
  to store session state (e.g. `session:<id>` → `{ protocolVersion,
  createdAt, lastSeenAt }`, with a TTL). Reuse the existing Redis client
  pattern rather than introducing a new store.

### 5. Security requirements (from the spec)

- **Origin validation**: the server must validate the `Origin` header on
  incoming connections to guard against DNS rebinding attacks. Decide and
  document an allowlist policy appropriate for a public production API
  served from `mcp.bancadia.com` (this is a different threat model than the
  spec's "bind to localhost" guidance, which targets local dev MCP servers —
  call out explicitly in the implementation which parts of the spec's
  security section apply to a hosted-only deployment like this one, since
  not all of it applies verbatim to Workers).
- Auth (`tools/call` requiring a valid bearer token) and rate limiting
  continue exactly as today — the transport upgrade is layered around them,
  not a replacement.

### 6. JSON-RPC batching

The current supported protocol versions include `2025-06-18`, which removed
JSON-RPC batch request/response support from the spec. Do not add batch
array handling — single JSON-RPC message per HTTP exchange, as today.

## Open questions for the implementing agent to resolve

These should be answered (with findings documented) before or during
implementation planning, not guessed at:

1. **Can the official `@modelcontextprotocol/sdk` TypeScript SDK's
   server-side Streamable HTTP transport run in the Cloudflare Workers
   runtime?** It may be built around Node's `http.IncomingMessage`/
   `ServerResponse` rather than the Web-standard `Request`/`Response` Hono
   uses. If it has (or can use) a Web-standard adapter, building on the
   official SDK is strongly preferred over hand-rolling the spec — it
   offloads correctness/edge-case risk to a maintained library. If it's not
   compatible with Workers, implement by hand against the spec document
   linked above as the source of truth.
2. **How long can a single Cloudflare Worker invocation hold an SSE response
   stream open**, and does the standalone `GET` stream (section 3 above)
   require a Durable Object to persist a connection beyond normal Worker
   execution limits? Investigate Cloudflare's constraints here before
   deciding whether the `GET` stream is fully implemented, implemented as a
   bounded/short-lived stream, or rejected with `405`.
3. **Session storage TTL/lifecycle**: how long should an idle session be
   kept alive in Redis before expiring, and what should happen to an
   in-flight `tools/call` if its session expires mid-request?
4. **Downstream coordination**: `bancadia-app`'s developer-facing docs
   (`src/app/docs/quickstart`, `src/app/docs/mcp-reference`) and
   `.well-known/mcp` describe today's wire behavior to external developers.
   Once this lands, those docs may need updating to mention session headers
   — flag this as a follow-up rather than in scope of this repo's change,
   since it's a separate repo.

## Suggested acceptance criteria

- An unmodified official MCP client library (e.g. the TypeScript
  `@modelcontextprotocol/sdk` client, or `claude mcp add --transport http`)
  can connect to a locally-run (`wrangler dev`) instance, complete
  `initialize`, receive and use a session ID, call `tools/list`, and call
  `tools/call` for `query_business_checking` — with no bancadia-specific
  client code.
- A request to `initialize` returns an `Mcp-Session-Id` header; a subsequent
  request omitting that header or using an invalid one is rejected per spec.
- A `POST` request that negotiates `Accept: text/event-stream` for
  `tools/call` receives a valid SSE stream terminating in the correct
  JSON-RPC response event.
- Existing plain-JSON single-shot callers (no `Accept: text/event-stream`,
  no session ID) continue to work exactly as before — this is the
  backward-compatibility bar, not preserving the current lack of session
  support.
- Existing auth and rate-limiting behavior on `tools/call` is unchanged.
- Test suite (`src/__tests__/`, run via `@cloudflare/vitest-pool-workers`)
  is extended to cover: session issuance/validation/expiry/termination, both
  POST response modes, and the GET stream (or its documented rejection).

## Likely touched files (for planning purposes, not prescriptive)

- `src/index.ts` — routing changes for GET/DELETE, response-mode branching.
- `src/lib/auth.ts` — unchanged in logic, but may need to be called from new
  code paths (e.g. `DELETE`, `GET`) if those also require auth.
- New module(s) for session management (e.g. `src/lib/session.ts`) and/or an
  SSE response helper.
- `src/types.ts` — any new `Env` bindings the chosen approach requires.
- `wrangler.toml` — only if a new binding (e.g. a Durable Object namespace)
  is introduced.
- `src/__tests__/` — new test coverage per the acceptance criteria above.
- `openapi.yaml` — update to reflect the new transport behavior once
  implemented, since it currently documents only the single-JSON-response
  shape.

## Resolved (implementation findings)

Answers to the four open questions above, as decided during implementation:

1. **SDK vs. hand-rolled — hand-rolled.** The official SDK does ship a
   Web-standard transport (`WebStandardStreamableHTTPServerTransport`,
   `@modelcontextprotocol/sdk` ≥ 1.29.0, `server/webStandardStreamableHttp.js`)
   built on `Request`/`Response`/`ReadableStream` and confirmed Workers-
   compatible per its own docstring. It was not adopted, however: its
   session/connection bookkeeping (`_streamMapping`, `_requestResponseMap`,
   etc.) lives in in-memory JS fields on the transport instance, which
   doesn't survive Workers' per-request isolate model unless every session
   gets its own Durable Object holding a persistent transport instance. That
   would have meant a new Cloudflare primitive this project has never used
   (new `wrangler.toml` binding + migration, different deploy/cost shape) to
   get resumability and exact upstream SSE framing that nothing here
   currently needs — no tool emits progress notifications, and there's no
   push-message use case yet. Given that, the transport was hand-rolled
   directly in `src/index.ts` against the spec text, with session state in
   Upstash Redis (`src/lib/session.ts`) — reusing the exact per-request
   client pattern already established in `src/lib/auth.ts`, with no new
   infrastructure.
2. **GET stream — implemented as a bounded stream, not rejected.** Cloudflare
   Workers has no hard wall-clock limit on a streaming response; the
   binding constraint is a ~100s *idle* timeout on non-Enterprise plans.
   The standalone `GET /` stream sends a keep-alive `ping` event every ~15s
   and self-closes after ~60s, so a compliant client just reconnects. No
   Durable Object was needed for this — each connection is independent and
   stateless beyond the session-id validation already required on every
   request.
3. **Session TTL/lifecycle**: sessions use a sliding-expiry TTL in Redis
   (`SESSION_TTL_SECONDS`, default 1800s / 30 min, configurable), refreshed
   on every request that validates successfully. This value is pure
   housekeeping — how long a client may pause between calls before it must
   re-`initialize` — not a cost or connection-duration control; no Worker
   invocation runs, and nothing is billed, while a session record merely
   exists between requests. Session validation happens once, at the start of
   request handling: a session that idle-expires *during* a long-running
   `tools/call` does not abort that in-flight call, it simply won't validate
   on the *next* request.
4. **Downstream coordination**: out of scope for this repo, as anticipated.
   `bancadia-app`'s developer-facing docs (`src/app/docs/quickstart`,
   `src/app/docs/mcp-reference`) still describe the pre-upgrade single-JSON
   wire behavior and should be updated separately to mention
   `Mcp-Session-Id`, the two POST response modes, and the `GET`/`DELETE`
   methods now documented in this repo's `openapi.yaml`.

Also worth noting: the spec text is more specific than this document's
original summary on one point — a **missing** `Mcp-Session-Id` header on a
non-`initialize` request is `400 Bad Request`, while a header the server
doesn't recognize (unknown or expired) is `404 Not Found`. The implementation
and `openapi.yaml` distinguish these two cases accordingly.

Origin policy: requests with no `Origin` header (the normal case for
non-browser MCP clients) are always allowed; requests with an `Origin` header
are checked against a configurable allowlist (`ALLOWED_ORIGINS` env var) and
rejected with `403` otherwise. No current caller sends `Origin` at all, so
this is inert until browser-based use (e.g. the deferred chat integration)
resumes.

## For bancadia-app: developer-docs update guide

This section is written for whoever updates `bancadia-app`'s developer-facing
docs following this transport upgrade — a different agent, most likely, with
no other context on this change. It's self-contained: you shouldn't need to
read `bancadia-mcp`'s source to use it, only this section plus the current
content of the two stale files it references below. Everything in this
section reflects the transport as actually implemented and verified (not the
original target-behavior spec above, which was the plan going in).

The two files to update, both in `bancadia-app`:
- `src/app/docs/quickstart/page.tsx`
- `src/app/docs/mcp-reference/page.tsx`

### What changed, in one sentence

`initialize` is no longer optional. Every method except `initialize`
(`tools/list`, `tools/call`, and any notification) now requires a valid
`Mcp-Session-Id` header, which only a successful `initialize` call can issue
— any existing doc example that skips straight to `tools/call` will now get
back `400`.

### Exactly what's stale in each file

- **`quickstart/page.tsx`, Step 3, "Option B — raw JSON-RPC over HTTP"**: the
  curl example goes straight to `tools/call` with no `initialize` step and no
  session header. This is now broken and must be rewritten as a multi-step
  curl sequence — use the exact request/response bodies in "End-to-end client
  flow" below.
- **`quickstart/page.tsx`, Step 3, "Option A — an MCP-aware client"**:
  probably no code changes needed. Spec-compliant clients (`claude mcp add
  --transport http`, the `mcpServers` JSON config shape, the official SDK)
  handle `initialize` and session negotiation internally and transparently.
  Consider adding one sentence noting this so a reader isn't left wondering
  whether they need to do anything differently.
- **`mcp-reference/page.tsx`, "Transport" section**: the method table's
  `initialize` row says "Optional; not required before calling the other
  methods" — now false, delete or rewrite that claim. The paragraph below the
  table ("Calling initialize first is not required...") is also now false and
  should be replaced with the session-requirement explanation below. The
  table itself should gain a "Session required" column (see the table in
  "What changed" context below for the correct per-method values).
- **`mcp-reference/page.tsx`, "Errors" section**: the table currently has 3
  rows (`401`/`404`/`429`). Replace it with the 7-row table under "Complete
  error reference" below — it adds `400`, `403`, a second, distinct `404`
  case, and `405`.
- **`mcp-reference/page.tsx`**: needs a new **"Session management"** section
  (reads naturally right after "Transport", before "Authentication") — use
  "Session lifecycle" below as the source content.
- **`mcp-reference/page.tsx`**: needs new **"GET (standalone stream)"** and
  **"DELETE (session termination)"** sections, since the MCP endpoint now
  accepts those HTTP methods in addition to `POST`. Use "GET — standalone SSE
  stream" and step 5 of the client flow below.
- **`mcp-reference/page.tsx`, "Discovery & health endpoints" section**: no
  change needed — `GET /health` and `GET /.well-known/mcp` are outside the
  MCP transport and untouched by this work.

### End-to-end client flow (exact bodies to use in the docs)

Every step is against `https://mcp.bancadia.com/` (root path, trailing
slash). Replace `bcd_YOUR_TOKEN_HERE` with a real token from the developer
dashboard.

**1. `initialize`** — no auth, no session yet:

```
POST https://mcp.bancadia.com/
Content-Type: application/json
Accept: application/json, text/event-stream

{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "example-client", "version": "1.0.0" }
  }
}
```

Response — note the new `Mcp-Session-Id` response header. The client must
save this value and send it back on every subsequent call:

```
HTTP/1.1 200 OK
Mcp-Session-Id: 7e93bc81-b832-4c8b-9834-1bac55106e22
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "Bancadia MCP", "version": "2.0.0" }
  }
}
```

If the request's `Accept` header includes `text/event-stream`, the server
may instead respond `Content-Type: text/event-stream` with the identical
JSON-RPC object delivered as the `data` of one `message` SSE event before
closing the stream. `Mcp-Session-Id` is present as a response header either
way — it isn't affected by which body content-type was chosen. Docs don't
need to explain SSE mode in depth (no current tool needs it), but it's worth
one sentence noting the server supports it since spec-compliant clients may
request it by default.

**2. (optional) `notifications/initialized`** — the standard MCP lifecycle
notification. Now requires the session header too:

```
POST https://mcp.bancadia.com/
Content-Type: application/json
Mcp-Session-Id: 7e93bc81-b832-4c8b-9834-1bac55106e22

{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```
→ `202 Accepted`, empty body (unchanged from before this upgrade).

**3. `tools/list`** — no bearer token, but the session header is now
required:

```
POST https://mcp.bancadia.com/
Content-Type: application/json
Mcp-Session-Id: 7e93bc81-b832-4c8b-9834-1bac55106e22

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
```
→ Same response shape as before this upgrade (`result.tools` array
unchanged).

**4. `tools/call`** — both the session header AND the bearer token are
required:

```
POST https://mcp.bancadia.com/
Content-Type: application/json
Authorization: Bearer bcd_YOUR_TOKEN_HERE
Mcp-Session-Id: 7e93bc81-b832-4c8b-9834-1bac55106e22

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "query_business_checking",
    "arguments": { "monthly_fee_max": 0, "available_states": ["CA"] }
  }
}
```
→ Same response shape as before this upgrade (`result.content[0].text` is
still a JSON-encoded string requiring `JSON.parse`).

**5. (optional) `DELETE`** — explicit session termination when the client is
done (e.g. the user closes the chat/tab):

```
DELETE https://mcp.bancadia.com/
Mcp-Session-Id: 7e93bc81-b832-4c8b-9834-1bac55106e22
```
→ `204 No Content`, empty body. If the client never sends this, the session
simply idle-expires server-side (see "Session lifecycle" below) —
`DELETE` is a courtesy, not something a developer must remember to call.

There's no step 6 the docs need to cover for the normal query flow — the
standalone `GET` stream (below) is for server-initiated push messages, which
nothing in this deployment sends today, so a developer doesn't need to do
anything with it to successfully query data.

### Session lifecycle (source content for the new "Session management" section)

- A session is created only by a successful `initialize` call, returned via
  the `Mcp-Session-Id` response header.
- Every subsequent request on the MCP endpoint — `tools/list`, `tools/call`,
  `GET`, `DELETE` — must echo that same value back as an `Mcp-Session-Id`
  *request* header.
- Sessions idle-expire after ~30 minutes of inactivity by default (a sliding
  window — every valid request resets the clock). This is a housekeeping
  window, not a held-open connection: each call is an ordinary independent
  HTTP request: nothing is "kept alive" for 30 minutes.
- A request whose session has expired (or was never valid) gets `404` and
  the client must call `initialize` again to obtain a new session — this is
  the expected, normal way a long-idle client resumes, not an error state to
  alarm a developer about.
- `DELETE` lets a client end its session immediately (e.g. explicit logout)
  rather than waiting for idle expiry.

### GET — standalone SSE stream (source content for the new "GET" section)

`GET https://mcp.bancadia.com/` with `Accept: text/event-stream` and a valid
`Mcp-Session-Id` opens a stream for messages the server initiates outside of
a specific `tools/call` response (e.g. a future progress or sampling push).
No tool currently sends anything on it — the stream exists so that MCP
client libraries which open it unconditionally after `initialize` don't
fail. The server sends periodic keep-alive `ping` events and closes the
stream itself after roughly a minute; well-behaved clients reconnect
automatically. **This is handled by spec-compliant client libraries, if at
all — a developer integrating by hand (Option B / raw curl) never needs to
call this.** `GET` without `Accept: text/event-stream` returns `405`.

### Complete error reference (replaces the current 3-row Errors table)

| HTTP status | JSON-RPC `code` | Body | Meaning |
|---|---|---|---|
| `400` | `-32600` | JSON-RPC error object (only if the request had an `id`; a notification with a bad session gets the same status with **no body**) | Missing `Mcp-Session-Id` header on any request other than `initialize`, or an `MCP-Protocol-Version` header value this server doesn't support. |
| `401` | `-32001` | JSON-RPC error object | Unchanged: missing/malformed/unknown/revoked bearer token on `tools/call`. |
| `403` | — | **No JSON-RPC body** (plain text) | The `Origin` request header is present but not on the server's allowlist. Only relevant to browser-based callers — `curl`/SDK/CLI clients don't send `Origin` and are unaffected in practice. |
| `404` | `-32601` | JSON-RPC error object | Unchanged: unknown top-level `method`, or an unrecognized tool `name` passed to `tools/call`. |
| `404` | `-32600` | JSON-RPC error object (only if the request had an `id`; a notification gets the same status with **no body**) | **New.** The `Mcp-Session-Id` header doesn't match a known, unexpired session. Client should call `initialize` again to get a new one. |
| `405` | — | No body | `GET` request whose `Accept` header doesn't include `text/event-stream`. |
| `429` | `-32029` | JSON-RPC error object | Unchanged: per-token rate limit exceeded. |

The two `404` rows share an HTTP status but have different JSON-RPC `code`
values and different remediation (fix the tool/method name vs. re-initialize)
— call this out explicitly as two distinct table rows rather than collapsing
them, unlike the current single-row `404` treatment.

Example bodies for the new/changed cases:

```json
// 400 — missing Mcp-Session-Id (request had an id)
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32600, "message": "Missing Mcp-Session-Id header." } }

// 404 — unknown/expired session (request had an id)
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32600, "message": "Session not found or expired. Re-initialize." } }
```

`403` (Origin) and `405` (GET without SSE `Accept`) return **no JSON-RPC body
at all** — just the bare HTTP status with a plain-text or empty body. This is
unlike every other error case in this API. Worth a one-line callout in the
docs, since a developer who assumes every non-2xx response has a parseable
`error.code` would break on these two.

### What did NOT change (safe to leave as-is)

- `tools/call` result shape — `content[0].text` is still a JSON-encoded
  string requiring `JSON.parse`.
- `query_business_checking`'s argument list and result schema.
- Rate-limit headers and behavior (`X-RateLimit-*`, 100 req/60s default),
  and the `401`/`429` error shapes for it.
- `GET /health` and `GET /.well-known/mcp` — outside the MCP transport,
  untouched.
- The endpoint URL itself (`https://mcp.bancadia.com/`).

### Source of truth if anything here is ambiguous

`bancadia-mcp`'s `openapi.yaml` (the `/` path's `post`, `get`, and `delete`
operations) is the authoritative, exhaustive spec for every status code,
header, and body shape referenced above — this section is a curated summary
of it, written specifically for updating `bancadia-app`'s docs. If the two
ever disagree, `openapi.yaml` (and `src/index.ts`, the actual implementation)
wins.
