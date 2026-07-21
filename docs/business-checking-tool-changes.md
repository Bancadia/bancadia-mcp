# `query_business_checking` gap remediation — what shipped

## Purpose of this document

Handoff doc for whoever updates `bancadia-app`'s dev docs / API reference. It's a
factual changelog of the tool/response changes that shipped, not a design doc — for
the reasoning behind these choices, see
[`business-checking-tool-implementation-plan.md`](./business-checking-tool-implementation-plan.md)
(which itself resolves the open questions in
[`business-checking-tool-data-gaps.md`](./business-checking-tool-data-gaps.md)).

**No breaking changes.** Every existing field in `query_business_checking`'s
response keeps its name, type, and meaning. This is purely additive: new response
fields, plus one new tool.

## 1. New tool: `get_business_checking_listing`

A second tool is now routed (previously only `query_business_checking` was). It
takes one required argument and returns full detail on a single listing:

```json
{
  "name": "get_business_checking_listing",
  "arguments": { "listing_slug": "found-business-checking" }
}
```

- **Input:** `listing_slug` (string, required) — the new stable public identifier
  (see §3). Not the internal database `id`.
- **Output:** same JSON-RPC `content: [{ type: "text", text: "<json>" }]` envelope
  as every other tool. `JSON.parse(text)` yields an array with either one element
  (match found) or zero elements (no active listing has that `listing_slug`, or the
  argument was missing/malformed) — never an error for "not found."
- **Response shape:** everything `query_business_checking` returns for a listing
  (see §2), plus two more arrays: `additional_fees` and `features` (see §4). This is
  the tool to call for follow-up questions like "tell me more about X" or "what are
  the gotcha fees on X" after a `query_business_checking` result — use the
  `listing_slug` from that result.
- Auth, session, and rate-limiting behave identically to `query_business_checking` —
  no special handling needed by clients.

Suggested `bancadia-app` chat-agent framing: after `query_business_checking` returns
results, the model should prefer `get_business_checking_listing` over re-running the
broad query when the user asks to "dig deeper" on one named result — cheaper and
returns strictly more detail than the list tool provides.

## 2. New fields on `query_business_checking` results

The following fields are now present on every result object returned by
`query_business_checking` (and by `get_business_checking_listing`, which includes
this same base shape). All were already sitting in the database — this only changes
what the API surfaces, not what data exists.

**New identifier:**
- `listing_slug` (string) — pass this to `get_business_checking_listing` for a
  follow-up query on this specific listing.

**New nested `institution` object** (alongside the existing flat `institution_name`,
which is unchanged):
```json
"institution_name": "Found",
"institution": {
  "display_name": "Found",
  "website_url": "https://found.com",
  "logo_url": "https://found.com/logo.png",
  "institution_type": "fintech",
  "support_email": "support@found.com"
}
```
`institution_type` is one of `national_bank | regional_bank | community_bank |
credit_union | neobank | fintech` — useful for "is this a real bank or a fintech on
a partner bank" questions.

**New wire/cash/fee fields:**
`incoming_domestic_wire_fee`, `incoming_international_wire_fee`,
`outgoing_international_wire_fee`, `multicurrency_support`,
`cash_deposit_fee_per_100`, `monthly_cash_deposit_limit`,
`free_domestic_wires_per_month`, `per_transaction_fee_after_limit`.

**New ATM/overdraft/limits fields:**
`atm_fee_reimbursement`, `atm_fee_reimbursement_limit`, `atm_network`,
`overdraft_protection_available`, `overdraft_line_of_credit_available`,
`daily_debit_limit`.

**New banking-feature booleans:**
`ach_debit_block_available`, `positive_pay_available`, `remote_deposit_capture`,
`bill_pay_available`, `check_writing_available`, `corporate_card_available`,
`virtual_cards_available`, `physical_debit_card_available`.

All are nullable — null means "not applicable/not populated for this listing," same
convention as the fields that already existed (e.g. `apy`, `rtp_network`).

**No filter parameters changed.** `query_business_checking`'s input schema
(`monthly_fee_max`, `entity_types_accepted`, etc.) is untouched — this was
deliberately response-only, per the non-goals in the findings doc.

## 3. `listing_slug` — the new public identifier

A new column, `listing_slug` (e.g. `found-business-checking`), was added to the
underlying `business_deposit_accounts` table specifically to serve as a stable,
public, human-readable identifier for MCP tool responses — decoupled from the
internal database `id` (never exposed) and from `application_url` (marketing copy
that can change on rebrand). It's unique and indexed at the DB level. If
`bancadia-app`'s own UI ever needs to reference "this specific listing" outside of
raw DB access, this is the identifier to use — not `application_url`, not the PK.

## 4. `get_business_checking_listing`-only fields: `additional_fees` and `features`

These two arrays are **only** returned by `get_business_checking_listing`, not by
`query_business_checking` — deliberately, to keep the broad list-query response
bounded in size as the registry grows (these two source tables are one-to-many per
listing and could otherwise blow up a 12+-listing response).

### `additional_fees`

Sourced from a dedicated fees table. Each entry:
```json
{
  "fee_type": "overdraft",
  "amount": 35,
  "amount_description": null,
  "eligibility_criteria": null,
  "tiers": null,
  "waivable": false,
  "waiver_condition": null
}
```
`fee_type` is one of: `monthly_maintenance`, `overdraft`, `non_sufficient_funds`,
`account_opening`, `account_closing`, `minimum_balance`, `excess_transaction`,
`atm_foreign`, `paper_statement`, `dormancy`, `returned_item`, `stop_payment`,
`card_replacement`, `foreign_transaction`, `other`.

**Note:** wire and cash-deposit fee types (`wire_domestic_outgoing`,
`wire_domestic_incoming`, `wire_international_outgoing`,
`wire_international_incoming`, `cash_deposit`) are intentionally **excluded** from
`additional_fees` — those are already covered by the flat fields in §2
(`outgoing_domestic_wire_fee`, etc.), and are deliberately not duplicated here to
avoid two sources of truth for the same fee potentially disagreeing.

### `features`

Sourced from a features table, sorted by display order. Each entry:
```json
{ "category": "fraud_protection", "description": "Instant card freeze", "value": null }
```
`category` is one of: `payment_rails`, `cash_handling`, `cards_and_atm`,
`online_banking`, `fraud_protection`, `account_management`,
`platform_integrations`, `other`. `value` is a nullable number for quantified
features (e.g. a dollar limit or a count).

## Reference

- Full request/response schemas, including examples for both tools: `openapi.yaml`
  (updated alongside this change — `ToolsCallParams`, `BusinessCheckingResult`,
  `BusinessCheckingDetailResult`, `AdditionalFee`, `Feature`, `Institution`,
  `GetBusinessCheckingListingArguments`).
- Handler source: `src/handlers/query-business-checking.ts` (shared field mapper,
  `mapBusinessCheckingRow`) and `src/handlers/get-business-checking-listing.ts` (new
  handler, layers `additional_fees`/`features` on top of the shared mapper).
