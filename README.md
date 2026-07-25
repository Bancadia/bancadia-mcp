# Bancadia MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets MCP clients (Claude, other LLM agents, etc.) query Bancadia's registry of deposit account products — savings, checking, and CDs, both personal and business — with structured filters.

Runs as a [Cloudflare Worker](https://workers.cloudflare.com/) on [Hono](https://hono.dev/), exposing MCP over JSON-RPC 2.0 (Streamable HTTP transport), backed by [Supabase](https://supabase.com/) (Postgres) with an [Upstash Redis](https://upstash.com/) caching/rate-limiting layer.

## Endpoints

| Method | Path              | Purpose                                                       | Auth                        |
| ------ | ----------------- | -------------------------------------------------------------- | ---------------------------- |
| GET    | `/health`         | Liveness check                                                 | none                          |
| GET    | `/.well-known/mcp`| Public discovery/manifest (server info + tool list)            | none                          |
| POST   | `/`               | JSON-RPC 2.0 endpoint — `initialize`, `tools/list`, `tools/call`| session; `tools/call` also needs a bearer token |
| GET    | `/`               | Standalone SSE stream (server-initiated messages, keep-alive)  | session                       |
| DELETE | `/`               | Terminate a session                                             | session                       |

### MCP session lifecycle

1. `POST /` with `method: "initialize"` — no auth required. Returns an `Mcp-Session-Id` response header; every subsequent request must send that value back as the `Mcp-Session-Id` request header.
2. `POST /` with `method: "tools/list"` — session required, no bearer token needed. Returns the tool manifest.
3. `POST /` with `method: "tools/call"` — session **and** `Authorization: Bearer <token>` required. Per-token sliding-window rate limiting applies (`X-RateLimit-*` response headers on both success and 429).

Responses are plain JSON by default, or Server-Sent Events if the request's `Accept` header includes `text/event-stream`.

## Available tools

| Tool                          | Purpose                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| `query_business_checking`      | Filter business checking listings (fees, entity types, states, RTP rails, integrations, APY, etc.) |
| `get_business_checking_listing`| Full detail on one listing by `listing_slug` — fees and features, including per-plan-tier breakdowns |

See `src/lib/tools.ts` for the full JSON Schema of each tool's arguments, or query `GET /.well-known/mcp` / `tools/list` directly.

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
