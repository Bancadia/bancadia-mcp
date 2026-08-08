# Feature: Target Customer Segments on Business Deposit Listings

## Purpose of this document

Feature spec for a Claude Code planning agent to turn into an implementation plan
across two repos: `bancadia-db` (schema/migrations) and `bancadia-mcp` (tool
contract/handlers). This is a design doc, not a changelog — it states the problem,
the intended behavior, a starting-point schema, and the decisions that still need
to be made during planning. It does not assume the planning agent has read prior
conversation; everything needed is below.

## 1. Problem

Business deposit products aren't generic — banks build and market specific
accounts toward specific kinds of businesses. Some target early-stage startups
(e.g. Mercury, Grasshopper), some target freelancers/solopreneurs and content
creators (e.g. Found, Lili), some target brick-and-mortar retail or restaurant
operators, some target established SMBs with existing revenue. Today,
`business_deposit_accounts` has no way to express "who this account is built
for." `query_business_checking` can filter on hard eligibility (entity type,
state, revenue, credit) but has no signal for fit/relevance among listings that
are all technically eligible.

The goal: let an AI agent ask something like "best business checking for a
content creator LLC" and get results that surface accounts actually built for
that kind of business first, without excluding eligible accounts that simply
aren't tagged.

## 2. Goals

- Add a controlled, extensible way to tag a `business_deposit_accounts` listing
  with the type(s) of business it's built for.
- Use that tag as a **ranking/relevance signal** in `query_business_checking`
  (and any other business-product query tools that share the base table), not
  as a hard eligibility filter.
- Surface the tag(s) in tool output so a calling LLM (and eventually a human
  reviewing results) can see *why* a listing was ranked where it was.
- Keep the vocabulary small enough to be usable by an LLM doing zero-shot
  classification of a natural-language query, and cheap to extend later.

## 3. Non-goals (explicitly out of scope for this pass)

- **Not a hard eligibility filter.** A listing tagged "built for startups" is
  not restricted to startups — a query for an unrelated segment should still
  return it if it's otherwise eligible. See §6 for why.
- **Not the industry-exclusion/compliance list.** Some banks exclude specific
  industries entirely (e.g. no cannabis, no adult content, no gambling) for
  underwriting/compliance reasons — that's a hard-eligibility field (probably
  NAICS-code-based) and a separate feature. Don't conflate the two; if it's
  easy to leave a hook for it (e.g. don't name anything in a way that collides),
  do so, but don't build it here.
- **Not a vector/embedding matching system.** No pgvector, no semantic search,
  no ANN index. The existing structured-filter architecture is correct for
  this problem — see §6 for the reasoning if it's useful context.
- **Not an admin UI change.** `bancadia-app` presumably needs a way for
  internal ops (or eventually bank admins) to assign these tags to a listing.
  That's a follow-up ticket against `bancadia-app`, out of scope here. This
  spec covers `bancadia-db` and `bancadia-mcp` only — schema + MCP contract.
  Flag the admin-UI gap in the plan so it isn't forgotten, but don't build it.

## 4. Taxonomy

Two separate facets, not one flat list — they answer different questions and
an LLM will classify each more accurately if they're not mixed together.

**`industry_vertical`** — what kind of business:
`ecommerce`, `retail_storefront`, `restaurant_food_service`,
`content_creator_solopreneur`, `professional_services`, `real_estate`,
`healthcare_practice`, `construction_trades`, `trucking_logistics`,
`agriculture`, `saas_tech`, `nonprofit`

**`business_profile`** — what stage/shape of business:
`early_stage_startup`, `vc_backed`, `bootstrapped_solopreneur`,
`established_smb`, `high_growth`

This is a starting list (~17 values total), not exhaustive by design — see §6
on why it doesn't need to be. A listing can carry zero, one, or several values
from each facet (e.g. a listing might be tagged `content_creator_solopreneur`
+ `bootstrapped_solopreneur`).

Treat this list as a proposal. If the planning/dev agent or a human reviewer
wants to adjust specific values before building, that's fine — the mechanism
matters more than getting every label perfect on the first pass, and Postgres
enums can grow later via `ALTER TYPE ... ADD VALUE` (a migration, same as
every other controlled vocabulary in this schema, e.g. `feature_category_enum`,
`entity_type_enum`).

## 5. Data model (`bancadia-db`)

Follows the existing pattern used for `business_deposit_account_features`
(migration `030_business_deposit_account_features.sql`): a Postgres enum for
the controlled vocabulary, plus a join table keyed to the listing.

Attach to `business_deposit_accounts` (the base table), **not** to
`business_checking_details` or another per-product-type detail table. The base
table already holds `entity_types_accepted` and `available_states` for the
same reason — see the comment on `entity_types_accepted` in
`020_business_deposit_accounts.sql`: "Lives on base because it applies across
all business product types." Target segments should follow the same rule, so
tagging is shared automatically across business checking, savings, and CD
listings rather than needing to be duplicated per product type.

Starting-point DDL (next migration would be `047_...` — confirm against
whatever is latest at implementation time):

```sql
CREATE TYPE target_segment_category_enum AS ENUM (
  'industry_vertical',
  'business_profile'
);

CREATE TYPE target_segment_enum AS ENUM (
  -- industry_vertical
  'ecommerce',
  'retail_storefront',
  'restaurant_food_service',
  'content_creator_solopreneur',
  'professional_services',
  'real_estate',
  'healthcare_practice',
  'construction_trades',
  'trucking_logistics',
  'agriculture',
  'saas_tech',
  'nonprofit',
  -- business_profile
  'early_stage_startup',
  'vc_backed',
  'bootstrapped_solopreneur',
  'established_smb',
  'high_growth'
);

CREATE TABLE business_deposit_account_target_segments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES business_deposit_accounts(id) ON DELETE CASCADE,
  category    target_segment_category_enum NOT NULL,
  segment     target_segment_enum NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, segment)
);

ALTER TABLE business_deposit_account_target_segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_target_segments_fi ON business_deposit_account_target_segments
  FOR ALL
  USING (listing_id IN (
    SELECT id FROM business_deposit_accounts
    WHERE institution_id = (SELECT institution_id FROM institution_users WHERE user_id = auth.uid())
  ));

CREATE INDEX idx_business_target_segments_listing
  ON business_deposit_account_target_segments(listing_id);
```

This mirrors `business_deposit_account_features` closely enough that it should
be low-risk to build. `category` is technically derivable from `segment` (each
segment value only ever belongs to one category), so it's a convenience
denormalization, same tradeoff the features table already makes with its
`category` column — flag this to the planning agent as an option to drop if
they'd rather look it up from the enum value, but the denormalized version
keeps the query/filter logic in the MCP layer simpler.

A `UNIQUE (listing_id, segment)` constraint prevents duplicate tags on the same
listing; there's no reasonable case for a listing having the same segment
twice.

## 6. MCP server changes (`bancadia-mcp`)

### 6.1 The behavior that matters most: soft-match ranking, not a hard filter

This is the part most likely to get built wrong by default, so it's called out
explicitly. When a caller passes target-segment values to `query_business_checking`:

- **Do not exclude** listings that don't have a matching tag, as long as they
  pass all the existing (real) eligibility filters.
- **Do** reorder results so tagged/matching listings rank ahead of
  non-matching ones.

Why: unlike `entity_types_accepted` or `available_states`, a target-segment tag
is not a hard legal/eligibility requirement — a startup can absolutely open an
account that isn't specifically marketed toward startups. Treating it as a hard
filter creates two failure modes that are worse than not having the feature:
(1) a listing that should've been tagged but wasn't (data gap) silently
disappears from results instead of just ranking lower, and (2) if the calling
LLM slightly misclassifies the query against this vocabulary, the query can
return zero results instead of degrading gracefully. Ranking-with-fallback
avoids both.

This is also why this feature doesn't need embeddings/vector search to be
"smart enough" — it only ever needs to pick the closest label(s) from a
short, described enum, which is a good fit for what an LLM does when filling
in an MCP tool's structured input schema (the same mechanism already used for
every other filter parameter on this tool).

### 6.2 Tool input schema

Add two new optional array parameters to `query_business_checking`'s
`inputSchema` (`src/lib/tools.ts`), matching the `entity_types_accepted` /
`available_states` style already used there — each enum value should get a
one-line description in the schema so the calling LLM can disambiguate close
categories (e.g. `content_creator_solopreneur` vs. `bootstrapped_solopreneur`):

```jsonc
"target_industries": {
  "type": "array",
  "items": { "type": "string", "enum": [/* industry_vertical values */] },
  "description": "Soft-ranks results toward listings built for these business types. Does not exclude non-matching but otherwise-eligible listings."
},
"target_business_profiles": {
  "type": "array",
  "items": { "type": "string", "enum": [/* business_profile values */] },
  "description": "Soft-ranks results toward listings built for this business stage/shape. Does not exclude non-matching but otherwise-eligible listings."
}
```

Two params rather than one merged array, since the two facets answer different
questions and mixing them makes "how many of N requested tags matched" scoring
ambiguous. Open to being merged if the planning agent has a good reason — see
§7.

### 6.3 Handler changes (`src/handlers/query-business-checking.ts`)

The handler already does JS-side post-processing on array-shaped attributes
for `entity_types_accepted` and `available_states` (see the block after the
Supabase query executes) rather than pushing that logic into the SQL/PostgREST
filter — this is the existing precedent to follow, just with sort semantics
instead of filter semantics:

1. Embed `business_deposit_account_target_segments(*)` in the `select()`
   alongside the other joined tables — no `!inner`, since non-matching rows
   must still come back.
2. After the existing JS-side filters run, if `target_industries` and/or
   `target_business_profiles` were provided, stable-sort `results` so that
   rows with **any** overlap between their tagged segments and the requested
   ones come first (any-of match, not all-of — unlike the `every()` semantics
   used for `entity_types_accepted`, where a listing must accept every
   requested entity type). Preserve the existing relative order (currently
   `monthly_fee ascending`) within each group — this is a reorder, not a
   re-sort from scratch.
3. Add the listing's tagged segments to the mapped output (`mapBusinessCheckingRow`
   in the same file) as two arrays, e.g. `target_industries` and
   `target_business_profiles`, so the calling LLM/UI can see and explain why a
   result ranked where it did. Untagged listings return empty arrays, not null.

### 6.4 `get_business_checking_listing`

Should also return the listing's tagged segments in its detail response, same
field names as above, for consistency.

### 6.5 Other business product handlers

`query-business-savings.ts` and `query-business-cd.ts` exist in the handlers
directory. If they're wired into `TOOLS` (confirm against current
`src/lib/tools.ts` at implementation time — they weren't in the version this
spec was written against) they should get the same treatment, since the tag
lives on the shared `business_deposit_accounts` base table and applies to
every business product type by construction.

## 7. Open questions for the planning agent

These are judgment calls, not blockers — pick a reasonable default and note
the choice in the implementation plan:

1. **One merged array param vs. two.** §6.2 recommends two
   (`target_industries` / `target_business_profiles`). If there's a strong
   reason to merge them into one `target_customer_segments` param, that's
   fine, but the ranking logic needs a documented tie-break for how a match on
   one facet weighs against a match on the other.
2. **Ranking weight when multiple values are requested/matched.** E.g. if a
   query requests two industries and a listing matches one, does it rank above
   a listing matching zero but below one matching both? A simple "count of
   matched requested values, descending" is probably sufficient for v1 — call
   it out explicitly in the plan rather than leaving it implicit in the sort
   comparator.
3. **Backfill.** There are currently 13 listings in the registry. Decide
   whether tagging existing listings is part of this implementation ticket
   (manual SQL insert/seed as part of the migration) or a separate ops task
   handed off after the schema/tool ships. Given the small number, doing it as
   part of this work is probably worth it so the feature is demonstrable
   immediately, but that's a scope call for whoever picks this up.
4. **`category` column vs. derive-from-enum.** Noted in §5 — keep or drop the
   denormalized `category` column on the join table.

## 8. Follow-ups explicitly deferred (not part of this ticket)

- `bancadia-app` admin UI for assigning segments to a listing.
- NAICS-based (or similar) hard industry-exclusion field for compliance —
  different problem, different field, don't conflate with this feature.
- Any raw-text/non-MCP demand channel adapter (e.g. for a partner that hands
  us unstructured conversational context instead of structured tool-call
  params) — not needed for the MCP path this spec covers, would be a separate
  feature if/when a channel like that materializes.
