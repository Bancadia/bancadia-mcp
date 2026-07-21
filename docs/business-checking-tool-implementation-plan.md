# `query_business_checking` gap remediation — implementation plan

## Purpose of this document

This is the implementation plan for the gaps catalogued in
[`business-checking-tool-data-gaps.md`](./business-checking-tool-data-gaps.md) ("the
findings doc"). It makes the calls that doc explicitly left open, sequences the work,
and specifies file-level changes. References below are to current code, verified
against `HEAD` on `feat/session-stream` (identical to `main` for the files touched
here).

## Decisions made (resolving the findings doc's open questions)

### Decision 1 — Gap 2 identifier: a new `listing_slug` column, not `id` or `application_url`

Neither candidate in the findings doc holds up on inspection:

- **`business_deposit_accounts.id`** — rejected as-is, per the findings doc's own
  leaky-abstraction concern. This repo has no migrations directory (`find . -iname
  "*.sql"` returns nothing — schema is owned outside this repo), so there's no local
  guardrail stopping a raw PK from becoming a de facto public contract once it ships
  in a tool response.
- **`application_url`** — I checked `database.types.ts`; there is no unique
  constraint visible on this column (it's just `application_url: string`, not part of
  any `Relationships` entry), and there are no migration files in this repo to check
  further. It's marketing/redirect copy (`go_clicks.slug` follows the same `/go/{slug}`
  pattern and is explicitly click-tracking, not an identifier), so it's reasonable to
  assume it can be edited when an institution rebrands a product — which would silently
  break any client that saved it as a reference.

**Decision: add a new column, `listing_slug`, on `business_deposit_accounts`** (not
just the checking-specific detail table — it belongs on the base table so
`business_savings`/`business_cd` tooling gets the same mechanism for free later
without another migration). Properties:
- Human-readable, e.g. `found-business-checking` — generated at listing
  curation/publish time, independent of `product_name` or `application_url` so
  renames don't cascade into it.
- `UNIQUE NOT NULL`, indexed — a real DB constraint, not convention, so point lookups
  are O(1) the way a PK lookup would be.
- Decoupled from the marketing redirect slug (`go_clicks.slug`) so the two can evolve
  independently (one is public API identity, the other is an outbound-click tracking
  artifact).

This is a **cross-repo dependency**: this repo has no migration files, so the column
addition happens wherever the Supabase schema is actually owned (confirm with
whoever ran the `business_checking_details`/`business_deposit_fees` migration before
starting Phase 5). `src/lib/database.types.ts` is generated — regenerate it after the
column lands; do not hand-edit it (per this repo's existing convention).

### Decision 2 — list tool vs. detail tool: split by payload cost, not by "does it exist in Gap 1"

The findings doc frames Gap 1 as "fields that exist but never reach tool output" —
true, but it doesn't mandate *which* tool should return them, and Gap 2 separately
flags that `query_business_checking` already returns 12+ full nested listings per
call and that this "will not scale." Dumping every Gap 1 field into the existing list
tool would fix Gap 1 while making Gap 2's own complaint worse. So this plan splits
Gap 1 by cost:

- **Cheap, stays in `query_business_checking` (the list tool):** Gap 1a's ~22 columns
  and Gap 1d's institution columns are scalars already sitting in the row the query
  already fetches (`business_checking_details(*)` is already selected — see
  `src/handlers/query-business-checking.ts:21`). Adding them to the `.map()` costs
  zero extra queries/joins, only marginally larger JSON per listing. No reason to
  gate these behind a second round-trip.
- **Expensive, detail-tool-only:** Gap 1b (`business_deposit_fees`) and Gap 1c
  (`business_deposit_account_features`) are one-to-many joins that can each return an
  unbounded number of rows per listing. Joining both into a query that already
  returns a dozen+ listings is exactly the payload-bloat problem Gap 2 describes.
  These are only added to the new single-listing detail tool (Phase 5), where the
  "many rows, but only for one listing" cost is bounded and justified by the caller
  having asked for depth on one specific thing.

Flagging this as a judgment call beyond what the findings doc literally specifies —
if the product direction actually wants fees/features in the broad list response
too, that's a one-line change to Phase 5's handler reuse in Phase 3/4, but I'd
recommend confirming real listing-count growth projections first.

### Decision 3 — `business_deposit_fees` vs. flat fee columns: additive, not a replacement

The findings doc flags a possible overlap between `business_checking_details`'s flat
fee columns (`outgoing_domestic_wire_fee`, etc., landing in Phase 1) and
`business_deposit_fees` rows of matching `fee_type`. Rather than guessing at data
population, this plan avoids the conflict structurally: `business_deposit_fees` rows
are only surfaced (Phase 4) for `fee_type` values that have **no** corresponding flat
column —

```
Excluded from additional_fees (covered by flat columns, Phase 1):
  wire_domestic_outgoing, wire_domestic_incoming,
  wire_international_outgoing, wire_international_incoming, cash_deposit

Included in additional_fees:
  monthly_maintenance, overdraft, non_sufficient_funds, account_opening,
  account_closing, minimum_balance, excess_transaction, atm_foreign,
  paper_statement, dormancy, returned_item, stop_payment, card_replacement,
  foreign_transaction, other
```

This sidesteps "which is the source of truth" — each field has exactly one source —
without blocking on a data audit. **Before Phase 4 ships**, run one query grouping
`business_deposit_fees` by `fee_type` for populated listings to sanity-check this
split holds in practice (e.g. confirm `wire_domestic_outgoing` rows aren't the *only*
place some listings' wire fees actually live, which would mean Phase 1's flat column
is null where Phase 4's excluded row had the real answer). If that audit finds
meaningful population in the "excluded" types, promote those specific `fee_type`s
into `additional_fees` too — the split is a starting default, not a hard rule.

## Response field placement

New/changed keys in the `query_business_checking` (list) response, mapped in
`src/handlers/query-business-checking.ts`'s existing `.map()`:

Flat additions from `business_checking_details` (Gap 1a — all already selected, just
add to the return object at `query-business-checking.ts:108-151`):
`incoming_domestic_wire_fee`, `incoming_international_wire_fee`,
`outgoing_international_wire_fee`, `multicurrency_support`,
`cash_deposit_fee_per_100`, `monthly_cash_deposit_limit`, `atm_fee_reimbursement`,
`atm_fee_reimbursement_limit`, `atm_network`, `overdraft_protection_available`,
`overdraft_line_of_credit_available`, `per_transaction_fee_after_limit`,
`free_domestic_wires_per_month`, `daily_debit_limit`, `ach_debit_block_available`,
`positive_pay_available`, `remote_deposit_capture`, `bill_pay_available`,
`check_writing_available`, `corporate_card_available`, `virtual_cards_available`,
`physical_debit_card_available`.

Institution expansion (Gap 1d) — change `.select('*, ..., institutions(name), ...')`
to `institutions(name, display_name, website_url, logo_url, institution_type,
support_email)`. **Keep the existing flat `institution_name` key as-is** (external
clients, including `bancadia-app`, already depend on it — this is a public tool
response shape, treat it like the API contract the findings doc says Gap 2's
identifier will become). Add the rest as a new nested `institution` object:

```json
"institution_name": "Found",
"institution": {
  "display_name": "Found",
  "website_url": "https://...",
  "logo_url": "https://...",
  "institution_type": "fintech",
  "support_email": "support@..."
}
```

New response-shape additions, detail tool only (Phase 5): `additional_fees` (array
from `business_deposit_fees`, per Decision 3) and `features` (array from
`business_deposit_account_features`, grouped/sorted by `sort_order` within
`category`).

**Explicitly not added anywhere** (per the findings doc's non-goals, restated so
Phase 1 doesn't accidentally scope-creep during implementation): `schema_version`,
`custom_fields`, `agent_matching_paused`, `is_affiliate_tracked`, `tracker_url`, and
any raw audit timestamp beyond the already-returned `last_modified`.

## Phased plan

Phases 1–4 have no schema dependency and can ship independently of Phase 0/5. Phase 5
depends on Phase 0 (external migration) landing first.

### Phase 1 — Gap 1a: extend the response mapper (no schema change)

- `src/handlers/query-business-checking.ts`: add the 22 fields listed above to the
  `.map()` return object (lines ~108–151). No `.select()` change needed —
  `business_checking_details(*)` already fetches them.
- Update `src/__tests__/query-business-checking.test.ts`: extend `sampleListing`'s
  `business_checking_details` fixture with the new columns, extend the "result
  objects contain all required fields" test's `toHaveProperty` list.

### Phase 2 — Gap 1d: expand institution data (no schema change)

- `src/handlers/query-business-checking.ts`: widen the `institutions(...)` select
  (line 21) and the `BusinessCheckingQueryRow` type (lines 5–10) to include
  `display_name, website_url, logo_url, institution_type, support_email`.
- Add the nested `institution: {...}` object in the `.map()`, keep `institution_name`
  unchanged (see field-placement section above).
- Update `sampleListing.institutions` fixture and the field-presence test.

### Phase 3 — Gap 1b: join `business_deposit_fees` (detail tool only)

- New handler `src/handlers/get-business-checking-listing.ts` (see Phase 5) selects
  `business_deposit_fees(*)` and maps it to `additional_fees`, filtered per Decision
  3's exclusion list, shape:
  ```json
  { "fee_type": "overdraft", "amount": 35, "amount_description": null,
    "eligibility_criteria": null, "tiers": null, "waivable": true,
    "waiver_condition": "..." }
  ```
- Run the data-population audit described in Decision 3 before this ships; adjust the
  exclusion list if it finds real data in an "excluded" type.

### Phase 4 — Gap 1c: join `business_deposit_account_features` (detail tool only)

- Same handler, select `business_deposit_account_features(*)`, map to `features`,
  sorted by `sort_order`, shape:
  ```json
  { "category": "fraud_protection", "description": "...", "value": null }
  ```

### Phase 5 — Gap 2: `get_business_checking_listing` tool

Blocked on Phase 0 (external): `listing_slug` column added to
`business_deposit_accounts`, unique + indexed, backfilled for existing rows, and
`database.types.ts` regenerated to include it.

Once unblocked:
- `src/lib/tools.ts`: add a `get_business_checking_listing` entry to `TOOLS` —
  `inputSchema: { properties: { listing_slug: { type: 'string', description:
  'The listing_slug identifying a specific business checking listing, as returned by
  query_business_checking.' } }, required: ['listing_slug'], additionalProperties:
  false }`.
- `src/handlers/get-business-checking-listing.ts`: new handler.
  `.from('business_deposit_accounts').select('*, business_checking_details(*),
  institutions(*), business_deposit_plan_tiers(*), business_deposit_promotions(*),
  business_deposit_fees(*), business_deposit_account_features(*)').eq('listing_slug',
  args.listing_slug).eq('listing_status', 'active').eq('product_type',
  'checking').maybeSingle()`. Reuses Phase 1/2's field mapping plus Phase 3/4's
  `additional_fees`/`features`. Returns `object[]` — `[]` when not found, `[mapped]`
  when found — matching the existing "empty array on no match" convention so
  `src/index.ts`'s generic `ToolHandler` type and result-wrapping (`content: [{ type:
  'text', text: JSON.stringify(results) }]`) need no changes.
- `src/index.ts`: import the handler, add one line to the `toolHandlers` map (line
  ~194). No auth/rate-limit changes needed — both are already applied generically
  before dispatch.
- New test file `src/__tests__/get-business-checking-listing.test.ts`, following the
  existing mocking pattern in `query-business-checking.test.ts` (mock
  `createSupabaseClient`, `@upstash/redis`, `@upstash/ratelimit`). Cover: found case,
  not-found case (empty array, not an error), and that `additional_fees` excludes the
  wire/cash fee types per Decision 3.
- `openapi.yaml`: currently states "Only `query_business_checking` is currently
  routed" in at least two places (lines 119, 680) and enumerates
  `enum: [query_business_checking]` (line 682) — update both to include
  `get_business_checking_listing`, and document its request/response shape
  alongside the existing `query_business_checking` example (lines ~248–320).

## Explicit non-goals (carried over from the findings doc, unchanged)

- No new filter parameters on `query_business_checking`'s input schema. The new
  tool's `listing_slug` parameter is an identifier for a point lookup, not a filter —
  consistent with this constraint, not an exception to it.
- No conversation-history/session work — unrelated, already verified working.
- No mechanical dump of every remaining DB column — `schema_version`,
  `custom_fields`, `agent_matching_paused`, `is_affiliate_tracked`, `tracker_url`,
  and internal audit timestamps stay out, per the field-placement section above.
- No wiring up of the other dormant handlers (`query-business-savings.ts`,
  `query-business-cd.ts`, `query-personal-*.ts`) — confirmed via `openapi.yaml:119`
  and `git show b4ebf60` that these are intentionally unrouted pending their own
  hybrid-schema pass. Out of scope here; don't conflate with this plan.

## Suggested sequencing

1. Phase 1 + 2 (no schema dependency, immediately fixes the reproduction case from
   the findings doc — international wire fees and `multicurrency_support` are both
   Phase 1 fields). Ship first, independently.
2. Kick off Phase 0 (schema migration for `listing_slug`) in parallel — cross-repo,
   likely the longest lead time item.
3. Phase 3 + 4 (handler logic for fees/features mapping) can be written and unit
   tested against a stub schema while Phase 0 is in flight, then wired into Phase 5
   once the column lands.
4. Phase 5 ships once Phase 0 lands and Phase 3/4 code is ready.
