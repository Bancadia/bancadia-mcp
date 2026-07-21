# `query_business_checking` data gaps

## Purpose of this document

This is a findings document, not an implementation plan. It exists to hand off a
concrete, evidence-backed list of gaps to whoever writes the implementation plan for
fixing them. It does not prescribe the fix — in particular, the "how does a client
fetch more detail on one specific listing" question (Gap 2) has an open design
question that needs a decision before anyone writes code.

**Context for why this was investigated:** the `bancadia-app` `/chat` assistant is a
thin client on top of this MCP server's `query_business_checking` tool (see
`bancadia-app`'s `src/app/api/chat/route.ts` — it does no direct DB access, it only
calls tools discovered via `tools/list`). When testing that chat feature with a
realistic 3-turn conversation ("find me an account" → "tell me more about the Found
account" → "can I receive international wires and what are the fees?"), the
assistant could not answer the third question and said so honestly:

> "I apologize, but I don't have information on whether the Found Business Checking
> account supports receiving international wires or any associated fees for such
> transactions. My tools only provide information on features like domestic wire
> fees, but not international ones."

That response is *correct behavior given its inputs* — it didn't hallucinate. But it
exposed that the tool's output is missing data that already exists in the database.
This doc catalogs everything found that way: fields that exist in Postgres but never
reach the model, and the structural gap where there's no way to ask for "more detail
on this one specific listing" at all.

The chat feature itself is intentionally not being invested in beyond this — see the
framing below in "Why this matters." The value of finding these gaps is that they
apply to *any* MCP client (chat included), not just this one.

## Why this matters (product framing, not just a bug report)

Bancadia's premise is that an agent gets accurate, current product data in one
round-trip instead of scraping or guessing. Every column that exists in the DB but
never reaches `tools/call` output is a column where the best a well-behaved model can
do is refuse to answer — and a less careful model (different sampling run, different
underlying LLM, different system prompt) might fill the gap from its own training
data instead, which is exactly the trust problem Bancadia exists to prevent. The
gaps below aren't new filter criteria to bolt on (that's the over-fitting failure
mode we want to avoid) — they're existing, already-verified DB columns and tables
that the current handler simply never selects or maps into its response.

## Gap 1 — DB columns and tables that exist but never reach tool output

All of this is in `src/handlers/query-business-checking.ts`. The handler's Supabase
query currently selects:

```
business_deposit_accounts
  .select('*, business_checking_details(*), institutions(name), business_deposit_plan_tiers(*), business_deposit_promotions(*)')
```

`business_checking_details(*)` and the account row itself are fetched in full, but
the handler's final `.map()` (lines ~130–172) only copies a subset of fields into the
response object. Two other tables relevant to this tool are never joined at all.
Below is every gap found, grouped by source.

### 1a. `business_checking_details` columns selected from Postgres but dropped by the response mapper

The handler does `select('*, business_checking_details(*), ...')`, so these columns
are already in `details` in memory — they're just never copied into the returned
object. This is the cheapest category of fix (no new join, no new query, just
extending the `.map()`):

| Column | Type | Why it matters |
|---|---|---|
| `incoming_domestic_wire_fee` | `number` (required, not nullable) | Currently only `outgoing_domestic_wire_fee` is returned. A user asking "what does it cost to *receive* a wire" gets no data today. |
| `incoming_international_wire_fee` | `number \| null` | **This is the exact field the reproduction above needed and didn't have.** |
| `outgoing_international_wire_fee` | `number \| null` | Same — international wires are entirely absent from tool output today. |
| `multicurrency_support` | `boolean` | Directly relevant to "can I receive international wires" — right now the model has no signal for this at all. |
| `cash_deposit_fee_per_100` | `number \| null` | A classic "gotcha fee" — `cash_deposit_available` (boolean) is returned today, but not what it costs. |
| `monthly_cash_deposit_limit` | `number \| null` | Pairs with the above — free cash deposit up to a limit, fee per $100 after. Neither limit nor fee currently surfaces. |
| `atm_fee_reimbursement` | `boolean` | Not returned. |
| `atm_fee_reimbursement_limit` | `number \| null` | Not returned. |
| `atm_network` | `string \| null` | Not returned. |
| `overdraft_protection_available` | `boolean` | Not returned — a common "hidden fee" concern. |
| `overdraft_line_of_credit_available` | `boolean` | Not returned. |
| `per_transaction_fee_after_limit` | `number \| null` | Pairs with `free_transactions_per_month` (which *is* returned) — the fee that kicks in after the free limit is not. |
| `free_domestic_wires_per_month` | `number \| null` | Not returned — relevant context alongside the wire fee fields. |
| `daily_debit_limit` | `number \| null` | Not returned. |
| `ach_debit_block_available` | `boolean` | Not returned. |
| `positive_pay_available` | `boolean` | Not returned. |
| `remote_deposit_capture` | `boolean` | Not returned. |
| `bill_pay_available` | `boolean` | Not returned. |
| `check_writing_available` | `boolean` | Not returned. |
| `corporate_card_available` | `boolean` | Not returned. |
| `virtual_cards_available` | `boolean` | Not returned. |
| `physical_debit_card_available` | `boolean` | Not returned. |

For reference, what the handler *does* currently map from `business_checking_details`:
`free_transactions_per_month`, `cash_deposit_available`, `sub_accounts_supported`,
`rtp_supported`, `rtp_network`, `accounting_integration_available`,
`tax_integration_available`, `expense_integration_available`, `interest_bearing`,
`apy`, `apy_tiers`, `outgoing_domestic_wire_fee`. That's 12 of the ~34 columns on
this table.

### 1b. `business_deposit_fees` — an entire table that is never joined

This is the single biggest gap, and arguably more important than 1a. There is a
dedicated fees table, keyed by `listing_id` (and optionally `plan_tier_id`), with a
`fee_type` enum that already models almost every "gotcha fee" concept a user might
ask about:

```
fee_type_enum:
  monthly_maintenance | overdraft | non_sufficient_funds | account_opening |
  account_closing | minimum_balance | excess_transaction | atm_foreign |
  wire_domestic_outgoing | wire_domestic_incoming | wire_international_outgoing |
  wire_international_incoming | cash_deposit | paper_statement | dormancy |
  returned_item | stop_payment | card_replacement | foreign_transaction | other
```

Each row also carries `amount`, `amount_description` (free-text, for fees that
aren't a flat number — e.g. tiered or "varies"), `eligibility_criteria`, `tiers`
(JSON, for tiered fee structures), `waivable`, and `waiver_condition`.

**This table is not referenced anywhere in `query-business-checking.ts`.** Depending
on how populated it is relative to the flat columns on `business_checking_details`
(worth checking before designing the fix — there may be overlap/duplication between
`business_deposit_fees` rows of type `wire_domestic_outgoing` and the
`outgoing_domestic_wire_fee` column, for example), this table may be the more
complete and more future-proof source of fee data, since new fee types don't require
a schema migration — they're just a new enum value and a new row. The implementation
plan should decide whether `business_checking_details`'s flat fee columns and
`business_deposit_fees` rows are redundant, complementary, or whether one should be
considered the source of truth going forward.

### 1c. `business_deposit_account_features` — also never joined

A second entirely-unused table, keyed by `listing_id` (and optionally
`plan_tier_id`), with:

```
feature_category_enum:
  payment_rails | cash_handling | cards_and_atm | online_banking |
  fraud_protection | account_management | platform_integrations | other
```

Plus `description` (free text), `value` (nullable number, for quantified features
like a limit or count), and `sort_order`. This looks like the intended source for
"what are the primary features" style narrative answers — richer and more
marketable than the raw booleans on `business_checking_details`, and extensible
without a migration for new feature types. Also currently not joined or returned by
the handler at all.

### 1d. `institutions` — under-selected

The handler does `institutions(name)` — only `name` is pulled. The `institutions`
table also has `display_name`, `website_url`, `logo_url`, `institution_type`
(`national_bank | regional_bank | community_bank | credit_union | neobank |
fintech`), and `support_email`, none of which are returned today. `institution_type`
in particular seems like an easy, high-value addition — "is this a real bank or a
fintech/neobank layered on a partner bank" is a common and reasonable question, and
the registry already has the answer.

## Gap 2 — no way to fetch one specific listing / follow up in more depth

### The problem

`query_business_checking`'s input schema (`src/lib/tools.ts`) has no
`listing_id`, `product_name`, `institution_name`, or any other identifier parameter.
Every call is a broad filter query over the whole active listing set. There is no
tool call that means "give me everything about *this one* listing" — a follow-up
question like "tell me more about the Found account" can only be answered by
re-running the same broad filter and hoping Found reappears in the result set, using
whatever fields that broad query happens to return. There is no "zoom in" operation,
even in principle — so even after Gap 1 is fixed and the fields exist, a client
still can't request just one listing's full detail without re-fetching (and
re-filtering) the whole matching set.

This also means result-set size is a latent problem: today's Illinois-filtered
query already returns 12+ full listings (with nested plan tiers and promotions) for
one broad question. As the registry grows, "tell me more about X" paying the full
cost of the broad query just to read one listing out of it will not scale, and
burns tokens the model doesn't need.

### Open design question — what should the follow-up key be?

**This needs discussion in the implementation plan, not a decision here.** The two
candidates:

- **`business_deposit_accounts.id` (the "listing ID," a UUID).** This is the actual
  primary key everything else foreign-keys against
  (`business_checking_details.listing_id`, `business_deposit_plan_tiers.listing_id`,
  `business_deposit_promotions.listing_id`, and — if Gap 1b/1c are addressed —
  `business_deposit_fees.listing_id` and `business_deposit_account_features.listing_id`
  would too). It's the obvious, already-indexed join key for a "get one listing"
  query. But it is an internal database identifier. Exposing it to MCP clients means
  a third-party developer's agent could pass around and depend on a raw internal PK
  — a leaky abstraction, and one more thing that becomes a compatibility promise the
  moment it ships in a tool response.

- **`application_url`** (e.g. `/go/found/online-business-checking`). This is
  already returned in every `query_business_checking` response today, and it's
  already a public-facing, human-readable, presumably-stable value (it's what
  `bancadia-app`'s "Application Link" points users at, and it appears to double as
  the tracked outbound redirect — see `go_clicks.slug`, which looks related to the
  same `/go/{slug}` pattern). Using it as the follow-up key avoids exposing an
  internal PK, but it's worth confirming during planning: (a) whether it's
  guaranteed unique per listing at the DB level (a real constraint, not just
  convention), (b) whether it can change over time (if an institution renames a
  product and the slug is regenerated, does a client's saved reference break?), and
  (c) whether looking it up requires a full-table scan or whether it's actually
  indexed for point lookups the way `id` naturally is as a primary key.

The person writing the implementation plan should pick one (or propose something
else — e.g. a new, deliberately-public opaque slug column, decoupled from both the
internal PK and the marketing URL) and should explicitly justify the choice against
the leaky-abstraction concern above. Whatever is chosen becomes part of the tool's
public contract, so it's worth getting right before it ships rather than after.

### A shape worth considering (not a prescription)

Something like a second tool — `get_business_checking_listing` (or equivalent) —
taking a single identifier and returning one listing at full depth (all of Gap 1's
fields, plus fees and features tables), separate from `query_business_checking`'s
existing broad-filter/list behavior. This keeps `query_business_checking`'s input
schema from growing an identifier parameter that only makes sense in single-result
mode, and keeps the "list vs. detail" distinction explicit for the model rather than
overloading one tool with two very different response shapes depending on which
arguments happen to be present. Again — this is a starting point for discussion, not
a decision.

## Explicit non-goals (per product direction)

- Do not add new *filter* parameters to `query_business_checking`'s input schema as
  part of fixing this. These gaps are about the *response* under-reporting data that
  already exists for whatever filters are already passed — not about giving the
  model more ways to slice the query.
- Do not build conversation-history/session persistence as part of this work — that
  was investigated separately and found to already work correctly (`bancadia-app`'s
  `useChat()` sends full message history by default; verified live against a 3-turn
  reproduction). It's unrelated to these gaps and out of scope here.
- Resist the urge to expose every DB column mechanically. Some columns
  (`schema_version`, `custom_fields`, `agent_matching_paused`,
  `is_affiliate_tracked`, `tracker_url`, internal audit/timestamps) are operational,
  not product data, and should very likely stay out of tool responses. The
  implementation plan should draw this line deliberately per table, not just union
  everything selected in Gap 1 into the response without judgment.

## Appendix — current state for reference

**Current tool input schema** (`src/lib/tools.ts`): `monthly_fee_max`,
`minimum_opening_deposit_max`, `entity_types_accepted`, `available_states`,
`insurance_type`, `cash_deposit_available`, `sub_accounts_supported`,
`free_transactions_min`, `rtp_supported`, `rtp_network`,
`accounting_integration_available`, `tax_integration_available`,
`expense_integration_available`, `interest_bearing`, `apy_min`.

**Current handler joins** (`src/handlers/query-business-checking.ts`):
`business_deposit_accounts` (base table) + `business_checking_details` (1:1) +
`institutions(name)` (name only) + `business_deposit_plan_tiers` (1:many) +
`business_deposit_promotions` (1:many). Not joined: `business_deposit_fees`,
`business_deposit_account_features`.

**Reproduction evidence:** a live 3-turn conversation was run against
`bancadia-app`'s `/api/chat` (local dev, real `mcp.bancadia.com` production
endpoint) with the message history explicitly included on each request. Turn 2
("dig deeper on Found, including hidden/gotcha fees") answered accurately but
sparsely, limited to the ~12 fields the tool actually returns. Turn 3 ("can I
receive international wires") correctly declined rather than hallucinating, citing
its tools' lack of international wire data — confirming both that history handling
works and that the gap is in tool output, not prompt/context plumbing.
