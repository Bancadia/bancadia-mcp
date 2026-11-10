# Bancadia MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets MCP clients (Claude, other LLM agents, etc.) query Bancadia's registry of business deposit account products (US only) — with structured filters.

Runs as a [Cloudflare Worker](https://workers.cloudflare.com/) on [Hono](https://hono.dev/), exposing MCP over JSON-RPC 2.0 (Streamable HTTP transport), backed by [Supabase](https://supabase.com/) (Postgres) with an [Upstash Redis](https://upstash.com/) caching/rate-limiting layer.

## Endpoints

| Method | Path              | Purpose                                                       | Auth                        |
| ------ | ----------------- | -------------------------------------------------------------- | ---------------------------- |
| GET    | `/health`         | Liveness check                                                 | none                          |
| GET    | `/.well-known/mcp`| Public discovery/manifest (server info + tool list)            | none                          |
| POST   | `/`               | JSON-RPC 2.0 endpoint — `initialize`, `tools/list`, `tools/call`| session; `tools/call` accepts an optional bearer token |
| GET    | `/`               | Standalone SSE stream (server-initiated messages, keep-alive)  | session                       |
| DELETE | `/`               | Terminate a session                                             | session                       |

### MCP session lifecycle

1. `POST /` with `method: "initialize"` — no auth required. Returns an `Mcp-Session-Id` response header; every subsequent request must send that value back as the `Mcp-Session-Id` request header.
2. `POST /` with `method: "tools/list"` — session required, no bearer token needed. Returns the tool manifest.
3. `POST /` with `method: "tools/call"` — session required; `Authorization: Bearer <token>` is optional (no header = anonymous, rate limited per IP; an invalid token is a 401). Sliding-window rate limiting applies (per token, or per IP via `ANON_RATE_LIMIT_REQUESTS` / `ANON_RATE_LIMIT_WINDOW_SECONDS`, default 60 / 60s) (`X-RateLimit-*` response headers on both success and 429).

Responses are plain JSON by default, or Server-Sent Events if the request's `Accept` header includes `text/event-stream`.

For production use, optionally obtain a bearer token (credits usage to you) from the [Bancadia developer portal](https://bancadia.com/developer/signup) — see [bancadia.com/docs](https://bancadia.com/docs) for full API documentation.

## Available tools

| Tool                          | Purpose                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| `query_business_checking`      | Filter business checking listings (fees, entity types, states, RTP rails, integrations, APY, etc.) |
| `get_business_checking_listing`| Full detail on one listing by `listing_slug` — fees and features, including per-plan-tier breakdowns |

See `src/lib/tools.ts` for the full JSON Schema of each tool's arguments, or query `GET /.well-known/mcp` / `tools/list` directly.

### Profiles (`legacy` and `v2`)

The MCP tool set is chosen per session. The default is `MCP_PROFILE` (`wrangler.toml`, currently `legacy`); a client opts in at `initialize` with the header `X-Bancadia-Profile: v2` or the URL query `?profile=v2` (header wins; read once, stored on the session). A tool name outside the session's profile is `-32601 Unknown tool`.

| Profile | Tools |
| ------- | ----- |
| `legacy` | `query_business_checking`, `get_business_checking_listing` (unchanged) |
| `v2` | `list_business_checking`, `search_facts`, `fees_by_type`, `get_listing` — slim, paged JSON backed by Postgres functions; schema in `docs/v2-tool-manifest.json`, behavior in `docs/v2-tool-spec.md` |

v2 lists accept the usual filters plus `has_active_promotion` (true: only listings with a current promotion, rows include it; recorded for only some banks) plus `remote_deposit_capture`, `check_writing_available`, `multicurrency_support`, `bill_pay_available`, `virtual_cards_available`, `corporate_card_available`, `physical_debit_card_available` (booleans) and `min_insured_usd` (banks with extended coverage but no published amount come back in `possible_matches`, with an `application_url`). Fields named in `fields` always appear (`false` = not offered, `null` = not published); `apy_max_condition` and `outgoing_domestic_wire_fee_note` qualify their value automatically. `get_listing` takes `query` (only matching features; features are capped, see `features_shown`/`features_truncated`), `fees_by_type` takes 1-5 fee types (`fees_omitted` when capped) and `search_facts` retries a zero-hit multi-term query as any-term (`relaxed: true`). Lists default to 7 rows (max 20, clamped; `next_offset` pages). DB validation errors (SQLSTATE `22023`) are returned as `-32602` with the valid values. `npm run measure:tokens` prints the v2 schema and default-list token sizes for a running Worker.

### REST API (always v2)

Resource-oriented routes, all with `{ data, meta }` envelopes: `GET /v1/business-checking-listings` (list; `data` is an array of rows, default 7 / max 20, paging in `meta`), `/business-checking-listings/{listing_slug}[?sections=]`, `/business-checking-listings/{listing_slug}/fees|features|promotions|plans` (no query params; `meta.listing` carries the tracked link), and the cross-listing reads `/business-checking-listings/-/fees` and `/-/facts` (use `-` in place of `{listing_slug}` to read across all listings). `GET /v1/business-checking` and `/v1/business-checking/{listing_slug}` remain as deprecated aliases (`Deprecation: true` and a successor-version `Link` header). REST ignores `MCP_PROFILE`. This is a breaking change from the earlier REST list (which returned every listing with full detail). OpenAPI: `GET /v1/openapi.json`, checked in as `docs/openapi-rest.json` (regenerate with `npx tsx scripts/print-openapi.ts > docs/openapi-rest.json`; a test fails on drift).

### `application_url` attribution tags

Every `application_url` returned by `tools/call` is an absolute `https://bancadia.com/go/...` link with attribution params appended: `src=mcp` (`src=rest` on the REST API) and `qr=<request_id>`, where `request_id` is a UUID generated once per `tools/call` and also written as that call's `query_events.request_id` and on each of its `query_match_events` rows (so a `/go` click can be joined back to the tool call, and listing, that surfaced it). Params already present on the stored URL are never overwritten. Every call to a known tool gets a `query_events` row — including zero-result calls, calls rejected for invalid arguments (`status = 'invalid_args'`) and failed calls (`status = 'error'`) — while `query_match_events` holds one row per returned listing. Host-prefixing and tagging happen in one layer: `applyApplicationUrlHost` (`src/lib/urls.ts`) for legacy tools, `tagResponse` (`src/lib/tag-response.ts`, with a runtime assert that every bank row is tagged) for v2, both applied in `runTool`.

**Clients and agents should pass `application_url` through unmodified, including its query string.** Stripping the params loses attribution for that click.

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in Supabase + Upstash credentials
npm run dev                      # wrangler dev — local server
```

`wrangler.toml [vars]` provides non-secret defaults (test Supabase/Upstash URLs, session TTL, allowed origins) shared by both `npm run dev` and the test suite; real secrets go in `.dev.vars` (git-ignored).

## Commands

```bash
npm run dev               # wrangler dev — local server
npm test                  # vitest run (runs inside workerd via @cloudflare/vitest-pool-workers)
npm run lint              # tsc --noEmit
npm run deploy:staging    # wrangler deploy --env staging
npm run deploy:production # wrangler deploy --env production
```

Run a single test file:

```bash
npx vitest run src/__tests__/query-business-checking.test.ts
```

## Environments

- **staging** — `bancadia-mcp-staging`, `workers.dev` enabled. Deployed automatically by CI on every push/PR to `main`.
- **production** — `bancadia-mcp-production`, routed at `mcp.bancadia.com/*`. Deployed manually via `npm run deploy:production`.

Secrets for each environment are set with `wrangler secret put <KEY> --env <environment>` and are never committed.

## Architecture

See [CLAUDE.md](./CLAUDE.md) for a detailed guide to the codebase: request flow, auth/session/rate-limit design, and the Supabase hybrid schema (base tables + per-product-type details tables) that the query handlers are built around.
