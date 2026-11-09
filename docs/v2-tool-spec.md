# Bancadia MCP v2 tool spec (token-efficiency project)

Normative for Phase 2B. The DB contract is `bancadia-db/plans/mcp-db-contract.md` (migrations 072-076); this file
says what the Worker does on top of it. Tests that encode this file live in `src/__tests__/v2-*.test.ts` and
`src/__tests__/integration/v2-*.integration.test.ts`. The v2 tool manifest (names, schemas, descriptions) is
`docs/v2-tool-manifest.json`: **the v2 `tools/list` result must deep-equal it** (a test enforces this).

## 1. Profiles

| | legacy | v2 |
|---|---|---|
| MCP tools | `query_business_checking`, `get_business_checking_listing` (code and output unchanged) | `list_business_checking`, `search_facts`, `fees_by_type`, `get_listing` |
| REST | never | always (the REST surface is v2 only, whatever `MCP_PROFILE` says) |

- Env var `MCP_PROFILE` = `legacy` | `v2`. Default `legacy` (add `MCP_PROFILE = "legacy"` to `wrangler.toml [vars]`; the later flip is that one line). Add it to `Env` in `src/types.ts`.
- Per-request override, read **once at `initialize`** (session creation): header `X-Bancadia-Profile: v2` or query `?profile=v2` on the MCP URL (header wins). Valid values are `legacy` and `v2`, case-insensitive; anything else is ignored (falls back to env).
- Stored on the session record (`SessionRecord.profile`, written by `createSession(env, protocolVersion, profile)`); the stored value is the **resolved** profile (override if valid, else `env.MCP_PROFILE`, else `legacy`). Effective profile for `tools/list` and `tools/call` = `record.profile ?? env.MCP_PROFILE ?? 'legacy'` (old sessions without `profile` follow the env).
- A tool name that is not in the session's profile gets the existing unknown-tool error (`-32601`, HTTP 404).
- `GET /.well-known/mcp` lists the tools of the env-default profile.
- `query_events.profile` = `legacy` | `v2` for every logged event (REST events: `v2`).
- Legacy output must stay byte-identical (modulo timestamps, `qr`, array order) to `src/__tests__/__golden__/*.json` (captured before any change with `npm run capture:goldens`; the legacy `tools/list` golden is byte exact).

## 2. Arguments

The exact JSON Schemas are in `docs/v2-tool-manifest.json`. No JSON-Schema `enum`s are used (they would break case-insensitivity and cost tokens); valid values are in descriptions and in the DB error text.

### list_business_checking -> `rpc('list_business_checking', { p_filters, p_fields, p_limit, p_offset })`
- `p_filters` gets only the keys the caller sent. Mapping: same name for `monthly_fee_max, minimum_opening_deposit_max, entity_types_accepted, available_states, insurance_type, rtp_network, cash_deposit_available, sub_accounts_supported, rtp_supported, accounting_integration_available, tax_integration_available, expense_integration_available, interest_bearing, has_active_promotion, remote_deposit_capture, check_writing_available, multicurrency_support, bill_pay_available, virtual_cards_available, corporate_card_available, physical_debit_card_available, min_insured_usd, free_transactions_min, apy_min, integrations_any, integrations_all, min_limits, sort`; **`rank_industries` -> `target_industries`, `rank_profiles` -> `target_business_profiles`** (rank only; the DB never excludes on them). `fields` -> `p_fields`; `limit` -> `p_limit`; `offset` -> `p_offset`. Omit `p_fields`/`p_limit`/`p_offset` when not sent (DB defaults: default fields, 7, 0).
- `has_active_promotion` (boolean; DB migration 078): true = at least one active promotion (`expiry_date` null or >= today), false = none; rows then include `promotions` (active only) even when `fields` omits it; counts in `excluded_by`. A non-boolean is `invalid_args` (Worker type check, or DB 22023). When it is sent (true or false) the list `notes` gets the extra sentence `Promotions are recorded for only some banks; no promotion listed may mean not recorded.` (absence of promotions means not recorded, not none exist).
- DB migration 079: the 7 new booleans behave like `cash_deposit_available`; `min_insured_usd` (USD) matches on the best of standard and extended limit and adds the three insurance fields to rows. A non-boolean/non-number is `invalid_args` (Worker type check, or DB 22023). Keys named in `fields`, plus columns of boolean filters in use, keep `false`/`null` (rows stay slim otherwise); `apy_max_condition` and `outgoing_domestic_wire_fee_note` are not selectable and appear next to their parent value.
- Clamping is the DB's: limit < 1 -> 1, limit > 20 -> 20, response `limit` is the effective one. The Worker never clamps or post-filters.
- `rank_*` have no exclusion semantics; `available_states: ["ALL"]` is accepted (matches listings that are nationwide).

### search_facts -> `rpc('search_listing_facts', { p_query, p_slugs, p_topic, p_per_bank, p_max_banks, p_max_chars })`
`query` required (empty string passes the Worker and is rejected by the DB: `p_query must not be empty`), `slugs`, `topic`, `per_bank` (1-5, default 2), `max_banks` (1-20, default 10), `max_chars` (40-600, default 220). Omit unsent params.

### fees_by_type -> `rpc('fees_by_type', { p_fee_types, p_slugs, p_plan })`
`fee_types` required (1-5), `slugs`, `plan` (default `default`). The DB returns `{results, returned_ids}`; at most 6 rows per bank, per-bank `fees_omitted: n` when capped; `description` is dropped when `amount_note` exists.

### get_listing -> `rpc('get_listing_sections', { p_slugs, p_sections, p_query })`
`slugs` required (1-4), `sections` (default `summary, tiers`, i.e. omit `p_sections`), `query` (passed as `p_query`, never case-folded: only matching features). Features are capped (8, 200 chars each): per listing `features_shown`, and `features_truncated: true` when rows or text were cut.

### Normalization (module `src/lib/normalize-args.ts`, `normalizeArgs(toolName, args)`)
Pure, returns a new args object, run after `validateArgs` and before the DB call:
- lower-cased (and trimmed): `insurance_type, rtp_network, sort, entity_types_accepted[], integrations_any[], integrations_all[], rank_industries[], rank_profiles[], fields[], min_limits` keys, `topic`, `fee_types[]`, `sections[]`, `slugs[]` (all tools).
- upper-cased (and trimmed): `available_states[]`.
- `plan` is passed trimmed, not case-changed (the DB compares case-insensitively).
- `query` (both tools), numbers and booleans untouched.
- Worker-side state validation: each `available_states` item must be `ALL` or one of the 50 states, DC, PR, VI, GU, AS, MP; otherwise `invalid_args` with message `Unknown state: ZZ. Valid states: AL, AK, ...` (DB gap: the DB accepts any string).

### Type checks (`validateArgs`, extend for the new schema types)
Add `integer` (finite whole number) and `object` (plain object; `additionalProperties.type` checked per value) to `src/lib/validate-args.ts`. `limit: "abc"`, `limit: 2.5`, `min_limits: {"sub_accounts": "x"}` -> `invalid_args` naming the argument.

## 3. Responses (MCP: `result.content[0].text` is `JSON.stringify` of the object below)

Rows are JSON objects. Slim: null/false/`[]`/`{}`/`""` are omitted by the DB; absence means false or unknown, `0` is kept. The Worker adds nothing but `notes`, `hint` and the tagged `application_url`, and removes `returned_ids`. **Affiliate status is never exposed**: no key anywhere in any response may be or start with `is_affiliate`, `tracker_url`, `affiliate_` (promo prose containing the word "affiliates" is fine).

### list_business_checking
```json
{
  "total_matches": 13, "returned": 2, "limit": 2, "next_offset": 2,
  "rows": [
    {"listing_slug": "novo-business-checking", "institution_name": "Novo Platform Inc.", "product_name": "Novo Business Checking",
     "monthly_fee": 0.00, "minimum_opening_deposit": 0, "insurance_type": "fdic",
     "application_url": "https://bancadia.com/go/novo/business-checking?src=mcp&qr=7d0c0e1e-2b8f-4f0a-9a43-0f6f3c1f9a11"}
  ],
  "excluded_by": {},
  "matches_overview": [{"slug": "novo-business-checking", "name": "Novo Platform Inc."}, "... all 13 matches, unpaginated order ..."],
  "notes": "Absent field = not offered or not published; true with no amount = offered, amount not published. Use fields to select more columns.",
  "hint": "Free-text fee and feature details are searchable: call search_facts(query, slugs) or get_listing(slugs, sections)."
}
```
- `next_offset` is `null` on the last page. `excluded_by` (per filter, how many listings it fails on its own; only non-zero keys; may be `{}`), `matches_overview` (**only when `total_matches > returned`**, `{slug,name}` only, no `application_url`, same order as the unpaginated result), `possible_matches` (`[{slug,name,application_url,snippet}]`, when an integrations filter or `min_insured_usd` was used; insurance entries mean extended coverage offered, amount not published) are passed through from the DB. Rows with an integrations filter carry `matched[]` (`{integration, connection_method?, plan, note}`), with `min_limits` `matched_limits[]` (`{key, value, plan}`).
- `notes`: always present, a single-line string (no `\n`, <= 300 chars) containing the words "Absent" and "not published". `hint`: present iff `returned > 0`; one line containing `search_facts`.
- Sort (DB): hard filters exclude, then client `sort`, then target-segment rank score, then affiliate-tracked first, then monthly fee, then id.

### search_facts
```json
{"hits": [{"slug": "found-online-business-checking", "name": "Indie Technologies, Inc. dba Found",
           "application_url": "https://bancadia.com/go/found/online-business-checking?src=mcp&qr=...",
           "facts": [{"topic": "fees", "plan": "all plans", "snippet": "One free cash deposit each month; after that a $2.00 fee ...",
                      "source_url": "https://found.com/help/funding-your-found-account/can-i-deposit-cash", "as_of": "2026-11-09"}]}],
 "scanned": 2, "banks_matched": 2,
 "no_match": [{"slug": "...", "name": "...", "application_url": "...tagged..."}],
 "unknown_slugs": ["nope"]}
```
`relaxed: true` appears when a zero-hit multi-term AND query was retried as OR. `no_match` only when `slugs` was sent; `unknown_slugs` only when some slug is not an active checking listing. Each bank appears once in `hits` (link once per bank, however many facts). `application_url` on every hit and every `no_match` entry.

### fees_by_type
MCP result text is the **bare array** (`.results` of the DB value; `returned_ids` removed):
```json
[{"slug": "citibank-streamlined-checking", "name": "Citibank, N.A.", "application_url": "https://bancadia.com/go/citibank/streamlined-checking?src=mcp&qr=...",
  "fees": [{"fee_type": "cash_deposit", "plan": "all plans", "amount": 0.35, "amount_status": "set", "fee_unit": "per_100",
            "free_allowance": {"amount": 5000, "unit": "usd", "period": "month"},
            "amount_note": "$0 for first $5,000 per month; $0.35 per $100 on amounts above $5,000 (New York)", "description": "..."}]}]
```

### get_listing
```json
{"listings": [{"slug": "relay-business-checking", "application_url": "https://bancadia.com/go/relay/business-checking?src=mcp&qr=...",
               "detail_has": ["tiers:3", "fees:17", "features:55"],
               "tiers": [{"plan_name": "Starter", "monthly_fee": 0.00, "is_default": true}],
               "fees": [{"fee_type": "monthly_maintenance", "plan": "all plans", "amount": 0.00, "description": "..."}]}],
 "not_found": ["nope"]}
```
Only requested sections are present (`summary`, `tiers`, `fees`, `features`, `promotions`); `detail_has` is always present and counts every non-empty section. Expired promotions (`expiry_date < current_date`) are never emitted, and `promotions:N` in `detail_has` agrees. `not_found` only when non-empty. Order = input order.

## 4. application_url tagging (`src/lib/tag-response.ts`)

After the DB returns (and after `returned_ids` is removed) `runTool` runs the post-projection step:

`tagResponse(toolName, payload, { src, qr }): payload` — for every bank-bearing row, turns the stored relative path (`/go/x/y`) into `https://bancadia.com/go/x/y` and appends `src` (`mcp` | `rest`) and `qr` (= the call's `query_events.request_id`) via `tagApplicationUrl` (never overwriting an existing param). Bank-bearing rows per tool:

| tool | paths |
|---|---|
| list_business_checking | `rows[]`, `possible_matches[]` (NOT `matches_overview[]`: link-free by design) |
| search_facts | `hits[]`, `no_match[]` |
| fees_by_type | each element of the (unwrapped) array |
| get_listing | `listings[]` |

Then `assertAllTagged(toolName, payload): void` throws `Error` (message starts `untagged application_url`) if any bank-bearing row lacks a string `application_url` that starts with `https://bancadia.com/`, has no `src`, or has no `qr`. `runTool` treats the throw as a server error (`status: 'error'`, logged as `error`; the client gets the generic internal error, never an untagged payload). `application_url` is always present on those rows, including under `fields` selection, paging and multi-slug; `possible_matches` entries are tagged and asserted like rows; `matches_overview` never carries one (by design). Legacy keeps `applyApplicationUrlHost`.

## 5. Errors

- Argument errors from `validateArgs`/state validation: MCP `-32602` with the message; REST 400 problem+json.
- DB exception with SQLSTATE `22023` (PostgREST `error.code === '22023'`): pass `error.message` through verbatim as `invalid_args` (it lists the valid values, e.g. `Unknown insurance type: bogus. Valid insurance types: fdic, ncua, uninsured`). MCP `-32602`, REST **400** (never 500), logged `status='invalid_args'`.
- Any other DB error or a tagging-assert failure: MCP `-32603` generic message, REST 500 generic, logged `status='error'`; the raw error stays in Worker logs.
- `src/lib/db-errors.ts`: `mapDbError(error: { message: string; code?: string }): { kind: 'invalid_args'; message: string } | { kind: 'error' }`.
- REST single-listing route: `not_found` -> 404 problem.

## 6. Logging (`query_events`, `query_match_events`)

One `query_events` row per call (also for `invalid_args` and `error`):

| column | value |
|---|---|
| request_id, tool_name, session_id, channel, user_agent, developer_id | as today (tool_name = the v2 tool name) |
| query_filters | the args as received (before normalization) |
| status | `ok` / `invalid_args` / `error` |
| profile | `v2` (REST and v2 MCP) or `legacy` |
| result_count | rows returned: list `returned`; search_facts `hits.length`; fees_by_type `results.length`; get_listing `listings.length` |
| total_matches | list `total_matches`; search_facts `banks_matched`; fees_by_type `results.length`; get_listing `listings.length`. null on errors and for legacy |
| offset | list: the effective offset (`max(args.offset ?? 0, 0)`); other tools null |
| fields | list: normalized `fields` array if sent, else null; other tools null |

`query_match_events`: only for banks in the DB function's `returned_ids` (`listing_id = id`, `listing_slug = slug`, `result_rank = rank` (global rank incl. offset), `institution_id = null`). Never for matches beyond the page, `matches_overview`, `possible_matches`, `no_match` or `not_found`. `returned_ids` (and any other key the DB marks internal) is removed from every client response (MCP and REST). Legacy logging unchanged except `profile = 'legacy'`.

## 7. REST (always v2)

All routes: same auth/rate-limit/CORS/headers as today; query params are exactly the tool schema properties (arrays comma separated; `limit`/`offset` integers; `min_limits=sub_accounts:12,free_wires:2`, i.e. `key:number` pairs); unknown params 400; `parseQueryParams` gains `integer` and `object` types. Envelope `{ data, meta }`; `meta` always has `count` (= number of items in `data`), `request_id`, `filters` (parsed args).

| route | tool | data | extra meta |
|---|---|---|---|
| `GET /v1/business-checking-listings` | list_business_checking | **array of listing rows** (breaking change: default 7, max 20) | `total_matches, returned, limit, next_offset, notes, hint?, excluded_by?, matches_overview?, possible_matches?` |
| `GET /v1/business-checking-listings/{listing_slug}` | get_listing (one slug; optional `?sections=`) | the one listing object | none (`count: 1`) |
| `GET /v1/business-checking-listings/{listing_slug}/fees` \| `/features` \| `/promotions` \| `/plans` | get_listing (one slug, `sections` fixed: fees, features, promotions, tiers) | that section's array (`[]` if none); **no query params allowed** (unknown -> 400) | `listing: {listing_slug, application_url}` (tagged) |
| `GET /v1/business-checking-listings/-/fees` | fees_by_type | array of banks | none |
| `GET /v1/business-checking-listings/-/facts` | search_facts | `hits` array | `scanned, banks_matched, no_match?, unknown_slugs?` |
| `GET /v1/business-checking` and `/v1/business-checking/{listing_slug}` | **deprecated aliases**: same handlers as the first two rows | same | same; responses carry `Deprecation: true` and `Link: </v1/business-checking-listings[/{slug}]>; rel="successor-version"` |

`-` is the wildcard path segment meaning "across all listings" (use `-` in place of `{listing_slug}`); it is never a slug: `.../-`, `.../-/features|promotions|plans` and any other `-/x` are 404. `/-/fees` and `/-/facts` are registered before the `{listing_slug}` routes. Unknown slug on the single or a sub-route (the DB's `not_found`) -> 404. There is no `/compare` and no top-level `/facts` or `/fees` (never deployed, no aliases; under the deprecated `/business-checking/{listing_slug}` alias those words are just unknown slugs -> 404). Sub-route logging is `tool_name = get_listing` with `query_filters = {slugs:[slug], sections:[section]}`. `application_url` tagging uses `src=rest`, `qr` = `X-Request-Id`. `src/lib/openapi.ts` generates the document for all 10 operations (the two aliases are `deprecated: true`); the generated document is checked in as `docs/openapi-rest.json` (printed by `scripts/print-openapi.ts`) and a test fails on drift. `openapi.yaml` (the hand-written MCP transport document) must list the 4 v2 tool names alongside the 2 legacy ones. `npm run lint:openapi` (Redocly) must pass in CI.

## 8. Token budgets

Guard: `tokens ~= chars / 2.16` (a fixed ratio measured on the real tokenizer for this JSON; the old chars/2.6 under-counted by about 20%). Do not use chars/4. For real counts run `cd go-to-market/demo-benchmark && npm run -s exp:tokcount -- /abs/path/file.json` (it uses that project's own key and prints only the count).
- v2 `tools/list` payload `JSON.stringify(tools)` <= **3,400** tokens (manifest: 7,134 chars; 3,197 real tokens, up from 2,649 for 5,718 chars before the 079 filters, the full `fields` list and `query`). Do not shorten unit hints (e.g. the `apy_min` decimal note).
- Default list response (no args, 7 rows, fully tagged, as the MCP text) <= **5,000** tokens (about 10,800 chars; the current output is about 4,000 chars).
- `scripts/measure-tokens.mjs` prints both numbers for a running Worker or the local DB; the tests assert the same bounds.

## 9. Files 2B is expected to change or add

New: `src/lib/tools-v2.ts` (manifest, must equal `docs/v2-tool-manifest.json`), `src/lib/normalize-args.ts`, `src/lib/tag-response.ts`, `src/lib/db-errors.ts`, `src/lib/profile.ts`, `src/handlers/v2.ts` (4 rpc handlers), `scripts/measure-tokens.mjs`, `docs/openapi-rest.json`.
Changed: `src/types.ts` (`MCP_PROFILE`), `wrangler.toml`, `src/index.ts` (profile at initialize, per-profile tools/list and tools/call, v2 result wrapping), `src/lib/session.ts`, `src/lib/run-tool.ts` (v2 pipeline: validate, normalize, rpc, map errors, strip internals, tag, assert, log), `src/lib/analytics.ts` (new columns, `returned_ids`-based match rows), `src/lib/validate-args.ts`, `src/lib/tools.ts` (profile-aware manifest), `src/rest/router.ts` and `params.ts`, `src/lib/openapi.ts`, `openapi.yaml`, `README.md`, `CLAUDE.md`, `package.json` (`measure:tokens`).
Existing tests that encode the old REST/`query_business_checking`-over-REST behavior and must be migrated by 2B (they are not edited in phase 2A): `rest-router.test.ts`, `openapi.test.ts` (mapper contract), `rate-limit.test.ts` / `auth.test.ts` REST cases that assert the legacy REST body, and `integration/rest-business-checking.integration.test.ts`.

## 10. Known DB gaps / ambiguities

1. `available_states` values are not validated by the DB (see state validation above; Worker-side).
2. `fees_by_type` and `get_listing_sections` have no `matches_overview`/paging; `search_facts` has no offset.
3. `no_match: []` is returned (empty) when `slugs` was sent and every bank hit; tests accept empty arrays.
