# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bancadia MCP is a Cloudflare Worker (Hono) that exposes a Model Context Protocol server over JSON-RPC 2.0. It lets MCP clients query Bancadia's registry of deposit account products (savings, checking, CDs — personal and business) with structured filters, backed by Supabase (Postgres) with an Upstash Redis caching/rate-limiting layer.

## Commands

```bash
npm run dev               # wrangler dev — local server against wrangler.toml [vars]
npm test                  # vitest run (uses @cloudflare/vitest-pool-workers, runs in workerd)
npx vitest run src/__tests__/query-business-checking.test.ts   # run a single test file
npm run lint              # tsc --noEmit (type-check only, no separate linter configured)
npm run deploy:staging    # wrangler deploy --env staging
npm run deploy:production # wrangler deploy --env production
```

Tests run inside the actual Workers runtime (workerd) via `@cloudflare/vitest-pool-workers`, not Node/jsdom — `cloudflare:test` provides `env`, `createExecutionContext`, `waitOnExecutionContext`. Local dev vars come from `.dev.vars` (git-ignored, see `.dev.vars.example`); `wrangler.toml [vars]` holds non-secret test-friendly defaults used by both `dev` and the test pool.

CI (`.github/workflows/ci.yml`) on push/PR to `main`: install → lint → test → deploy to staging automatically. There is no separate CI gate for production; `deploy:production` is run manually.

## Architecture

**Single-file router, multi-file handlers.** All request routing lives in `src/index.ts`: two routes only — `GET /.well-known/mcp` (public discovery/manifest) and `POST /` (the JSON-RPC 2.0 endpoint handling `tools/list` and `tools/call`). Each MCP tool has its own handler module under `src/handlers/`, dispatched through a `toolHandlers` map keyed by tool name in `index.ts`. To add a new tool: define its schema in `src/lib/tools.ts` (`TOOLS` array), write a handler in `src/handlers/`, and register it in the `toolHandlers` map in `index.ts`.

**Request flow for `tools/call`:** `tools/list` requires no auth; `tools/call` runs `authenticate()` (src/lib/auth.ts) → per-token sliding-window rate limit (Upstash, applied even before the handler runs, with `X-RateLimit-*` headers set on both success and 429 responses) → handler dispatch → JSON-RPC result wrapping the handler's array as a single `content: [{ type: 'text', text: JSON.stringify(results) }]` block.

**Auth is Redis-cached, Supabase-backed.** `authenticate()` hashes the bearer token (SHA-256), checks Redis (`token:<hash>`) first, and only falls back to a Supabase lookup against `developer_api_tokens` (`token_hash`, `revoked_at IS NULL`) on a cache miss. The result is cached back into Redis with a 60s TTL via `ctx.waitUntil()` — this is why `authenticate()` needs the Workers `ExecutionContext`, not just `Env`.

**Hybrid schema (base table + per-product-type details), mid-migration.** This is the key domain model to understand before touching handlers or `src/lib/tools.ts`:
- Two base tables carry shared columns: `personal_deposit_accounts` and `business_deposit_accounts`, each with a `product_type` column (e.g. `checking`, `hysa`/`money_market`, `cd`) and `listing_status`.
- Each product type has a companion one-to-one "details" table joined via Supabase's nested select syntax, e.g. `personal_savings_details`, `personal_checking_details`, `personal_cd_details`, `business_checking_details`, `business_savings_details`, `business_cd_details`.
- Handlers `.select('*, <details_table>(*), institutions(name)')` and, when sorting on a details-table column (e.g. `apy`), must pass `order(..., { foreignTable: '<details_table>' })` — the base tables themselves don't carry `apy`.
- `src/handlers/query-hysa.ts` and its `hysa_listings` table are leftover from the pre-redesign flat schema and are **no longer wired into `index.ts`**; the `query_hysa` tool is now served by `handleQueryPersonalSavings(args, env, { hysaOnly: true })`. Don't extend `query-hysa.ts` — treat it as dead code pending removal.
- `src/lib/database.types.ts` is the generated Supabase schema (source of truth for all table/column names — regenerate rather than hand-edit if the schema changes).

**Filtering split: Postgres vs in-memory.** ("Client-side" below means the Supabase JS client running inside the Worker, relative to the Postgres server — not the MCP client. Every filter, either way, is fully applied before the JSON-RPC response leaves the Worker; the calling LLM never sees unfiltered rows and never filters anything itself.)

Simple scalar/range filters on the base table (`eq`, `gte`, `lte`, e.g. `insurance_type`, `monthly_fee_max`) are pushed straight into the Supabase query builder. Scalar/boolean/range filters that read a value nested in a joined `*_details` table (e.g. `accounting_integration_available`, `apy_min`) are *also* pushed into the query builder as dot-path filters (`business_checking_details.accounting_integration_available`) — but a dot-path filter only restricts which parent rows come back when the embed uses the `!inner` join hint (`business_checking_details!inner(*)`). Without `!inner`, PostgREST treats the filter as shaping the embedded object only, not as a `WHERE` clause on the parent row — the filter becomes a silent no-op that lets non-matching rows through. So handlers with details-table filters must build the embed's join hint conditionally: add `!inner` only when the request actually includes one of those filters, so listings that don't yet have a populated details row still surface in unfiltered/base-filtered browsing. Only do this when the relationship is confirmed one-to-one in `database.types.ts` (`Relationships[].isOneToOne`) — see `query-business-checking.ts`'s `DETAILS_FILTER_KEYS`/`needsDetailsInner` for the reference implementation.

Filters that need "array contains all of" semantics (`available_states`, `entity_types_accepted`, `integrations`) are applied in-memory after fetch, using `Array.prototype.filter`, since that logic isn't expressible via the query builder's `.eq()`. `available_states` filtering treats a row's `['ALL']` as a wildcard match for any requested state.

When adding a new filter on a joined details table, don't rely on a bare `mockQueryChain`-style test double that unconditionally passes through `.eq()`/`.gte()` calls — it can't catch a filter that fails to actually restrict rows (this is exactly how the `accounting_integration_available` bug shipped). Use a fixture-driven mock that only treats dot-path filters as restrictive when `!inner` is present in the captured `.select()` string, so tests fail against a handler that forgets the join hint.

**Tool schemas are hand-written, not derived from the DB.** `src/lib/tools.ts` defines the `TOOLS` array (name, description, JSON Schema `inputSchema`) consumed by both `GET /.well-known/mcp` and `tools/list`; it has no automatic link to `database.types.ts` or to the handlers' actual filter logic, so when changing a handler's accepted args, update the schema in `tools.ts` by hand too.

**Env bindings** are typed once in `src/types.ts` (`Env`): `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and optional `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_SECONDS` (default 100 req / 60s). `createSupabaseClient()` (src/lib/supabase.ts) is a per-request factory, deliberately not a module-level singleton, since Workers isolates are stateless/ephemeral between requests.

**Environments:** `wrangler.toml` defines `staging` (workers.dev enabled) and `production` (workers.dev disabled, routed at `mcp.bancadia.com/*`). Secrets for each are set via `wrangler secret put <KEY> --env <environment>`, not committed.

## Testing conventions

Tests live in `src/__tests__/` and exercise the app through `app.fetch(request, env, ctx)` end-to-end rather than importing handler functions directly. Standard mocking pattern for a handler test:
- `vi.mock('../lib/supabase')` and `vi.mocked(createSupabaseClient).mockReturnValue({ from: vi.fn().mockReturnValue(chain) })`, where `chain` is a stub with `select/eq/neq/gte/lte/order/is` all returning itself and a `then` that resolves to `{ data, error }` — this fakes the Supabase query-builder's thenable chaining.
- `vi.mock('@upstash/redis')` and `vi.mock('@upstash/ratelimit')` are mocked in every handler test so auth and rate-limiting don't need real network calls (Redis `get` mocked to return `true` for an always-authenticated cache hit; ratelimit mocked to always `success: true`).
