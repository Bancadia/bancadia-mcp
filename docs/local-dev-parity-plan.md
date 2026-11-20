# Making local match dev/prod: plan

Status: proposal. Nothing here is implemented except the prototype loader described in section 6.

## 1. Problem and root cause

CI runs the integration suite against the hosted dev project. Locally, `db:reset` runs migrations first and the onboarding seeds second.
Data migrations 088-092 are `UPDATE`s, so on an empty database they match nothing. The seeds then insert the old values.
Local ends up with the pre-088 data. Tests and goldens written against local pass there and fail on dev.

Reproduced on 2026-11-18 by loading a full dev export into local: 13 failures locally, identical test names to the failing CI job.
The prototype export also showed local and dev differ in every row id (ids are `gen_random_uuid()` in the seeds), so "same data" has to mean "same rows, same ids".

This will recur. The verifier's apply path (future) will write listing data to dev and prod outside any migration, so no seed or migration replay can keep up. Local needs a copy of the data, not a re-derivation of it.

## 2. Options evaluated

| # | Option | Verdict |
|---|---|---|
| 1 | Data snapshot of the registry tables, generated from dev by a script, loaded by `db:reset` after migrations and seeds, plus a drift check against dev | Recommended core. Fixes the cause for any source of change (migration, verifier, manual edit). |
| 2a | Re-run data migrations after seeds | Stopgap only. Needs every data migration to be idempotent and re-runnable, and verifier edits never appear as migrations. |
| 2b | Make seeds the product of migrations (single source) | Rejected. Seeds create rows with random ids and migrations 088+ assume rows exist; rewriting 13 onboarding scripts into migrations is large and still blind to non-migration edits. |
| 3 | Tests derive expectations from the DB at run time; `goldens:update` with reviewed semantic diff | Recommended as the second layer. Cuts the number of literals that can go stale. |
| 4 | One `npm run check:local` | Recommended. It is the entry point for agents. |
| 5 | CI keeps hitting dev | Keep. Dev is ground truth. Local clone is the pre-push proxy, not a replacement. |

## 3. Recommendation

Do 1 + 3 + 4, keep CI on dev, add a scheduled drift job. Stop maintaining `seed_after_onboarding.sql` once the snapshot loader exists (it is the same stopgap in smaller form).

### 3.1 Snapshot (`db:sync-from-dev`)

- New `scripts/db/sync-from-dev.mjs` (bancadia-mcp). Reads the registry tables from dev over PostgREST with the dev service key (read from the environment or `.dev.vars.dev`, never printed, never written to the snapshot), paginated 1000 rows per request, ordered by primary key.
- Tables (all that `list_business_checking`, `get_listing_sections`, `fees_by_type`, `search_listing_facts`, the REST routes and the tests read, from migrations 073-094): `institutions`, `business_deposit_accounts`, `business_checking_details`, `business_deposit_fees`, `business_deposit_account_features`, `business_deposit_feature_integrations`, `business_deposit_plan_tiers`, `business_deposit_promotions`, `business_deposit_account_target_segments`, `integration_vocab`, `limit_key_vocab`. Not needed by the MCP code: `listing_sources`, `verifiable_fields`, `source_snapshots`, `verification_*`, personal_* (the personal tables hold rows in dev and nothing in local; no MCP tool reads them).
- Output: `.local/dev-snapshot.json` (gitignored) holding the rows plus a manifest `{ taken_at, dev_project_ref, tables: { name: { rows, hash } } }`. Size today about 600 KB. It is public registry data, no PII, no secrets.
- Hash: SHA-256 of a canonical JSON (keys sorted, numbers normalised in JS), computed in Node on both sides. Do not compare Postgres `md5(row)` text: numeric scale (`5.00` vs `5`) round-trips differently through PostgREST and would give false drift.
- Loader `scripts/db/load-snapshot.mjs`: see section 6. Runs inside `db:reset` after seeds: `supabase db reset --local && apply-grants && load-snapshot && seed-test-fixtures`. If no snapshot exists it prints a loud warning ("local data is the onboarding seed, NOT dev; integration results may differ from CI") and continues, so a fresh clone is not blocked.
- `db:verify-local`: reads the same tables from local, hashes, compares with the manifest. Fails if a table was changed after load (test mutated registry data) or the loader was skipped.
- `db:sync-from-dev --check`: reads dev, compares hashes with the manifest, prints per-table row counts and which tables drifted. No key present: prints "cannot check drift without DEV_SUPABASE_SECRET_KEY" and exits 0 locally, exits 1 in CI.
- Optional, to avoid handing an agent the service key: if the registry tables already allow anon `SELECT` for active listings, sync could use the publishable key for those. Check RLS first; unlisted/draft rows would be missed, so the service key stays the default.

### 3.2 Tests derive from the DB (layer 2)

Remaining literals that go stale when listing data changes, in order of churn:
1. `fixtures.ts` `REST_FILTER_CASES` (exact slug sets), `APY_EXPECTED`, `EXPECTED`.
2. Bluevine golden record in `business-checking-contract.integration.test.ts`.
3. `src/__tests__/__golden__/legacy-tool-outputs.json`.

Plan:
- Convert `REST_FILTER_CASES` and the `apy_*` assertions to the oracle pattern that `business-checking-contract` already uses (`FILTER_CASES` there has `keep(a, d)` predicates over raw rows). Keep two or three pinned facts per filter as a non-vacuity guard (for example "grasshopper is in cash_deposit_available=true") rather than the full set.
- Keep the Bluevine literal as a deliberately pinned golden (it guards the response shape end to end), but stamp it so it is updated through the same command as the legacy goldens.
- Legacy goldens guard code regressions, not data. Store `snapshot_hash` (the manifest hash of the tables the goldens read) inside `legacy-tool-outputs.json`. The golden test then fails with a precise message when the data moved: "goldens were captured at snapshot X, local is Y: run `npm run goldens:update` and review the diff", instead of 9 opaque deep-equal failures.
- `goldens:update` (rename of `capture:goldens`): refuses to run unless `db:verify-local` passes, writes the files, then prints the semantic diff per listing and field (old -> new), as done for this change, and the command exits non-zero if `legacy-tools-list.json` changed. The reviewer checks that each line is explained by a data change.

### 3.3 `npm run check:local`

One script, fail fast, in this order:
1. `db:sync-from-dev --check` (soft when no key, see above).
2. `db:reset` (migrations, seeds, snapshot, fixtures).
3. `db:verify-local`.
4. `npm run lint`, `npm run lint:openapi`.
5. `npm test`.
6. `npm run test:integration`.
7. `npm run measure:tokens` (manifest budget).

Agents run `npm run check:local` before every push. It needs Docker and the local stack; it takes about as long as `db:reset` plus the integration suite (a few minutes).

### 3.4 CI

- `integration` job: unchanged (dev is ground truth, serialised by the existing concurrency group).
- New scheduled workflow (daily, plus `workflow_dispatch`): `db:sync-from-dev --check` with the existing `dev-supabase` environment secret, then `db:reset` with a fresh snapshot and `test:integration` against local. A red result means one of: dev changed and tests/goldens need updating (the data case), or local replay differs from dev for some other reason (a parity bug). Running both dev and clone in CI is what proves parity rather than assuming it.
- CI gets the snapshot by running `sync-from-dev` in that job; it is never committed, so nothing stale can be checked in.

### 3.5 Verifier auto-apply

- The apply step ends by calling `db:sync-from-dev` (or just by relying on the daily drift job) so the next local run sees the change.
- Any apply that changes a field covered by a golden or pinned literal turns CI red until `goldens:update` is run and reviewed. That is intended: the test is telling you listing data moved. Run-time-derived expectations (3.2) mean most tests do not care.
- CI integration should keep hitting dev. A local clone in CI would hide the very drift we want to see. The clone is for agents and for the nightly parity job.
- Race to design before auto-apply ships: integration runs share dev with the verifier. The existing `integration-dev-supabase` concurrency group serialises CI runs only; the apply job should take the same group, or tests can see half-applied changes.

## 4. Files and config to change

bancadia-mcp:
- add `scripts/db/sync-from-dev.mjs`, `scripts/db/load-snapshot.mjs`, `scripts/db/verify-local.mjs`, `scripts/check-local.mjs`
- `package.json`: `db:sync-from-dev`, `db:verify-local`, `check:local`; `db:reset` gains `&& node scripts/db/load-snapshot.mjs` before `seed-test-fixtures.mjs`; rename `capture:goldens` to `goldens:update`
- `.gitignore`: `.local/`
- `scripts/capture-goldens.capture.ts`: print semantic diff, write `snapshot_hash`; `v2-profile-budget` golden test checks it
- `src/__tests__/integration/fixtures.ts` and the contract test: oracle-derived expectations (3.2)
- `.github/workflows/ci.yml` or a new `parity.yml`: scheduled job (3.4)
- `CLAUDE.md`: commands section (`check:local`, snapshot, never run goldens against dev)
bancadia-db:
- `supabase/seed_after_onboarding.sql` and its `config.toml` entry can be removed once the loader is live (the snapshot overwrites those tables). Keep the onboarding scripts: they still bootstrap a database for people without dev access.

## 5. Effort and risks

Effort: sync + load + verify scripts about half a day (the loader is already prototyped); `check:local` and package scripts 1-2 hours; converting literals to oracle assertions about half a day; scheduled workflow 1 hour. About 1.5 to 2 days in total.

Risks:
- Service key handling: needed only for `sync-from-dev` and the drift check. Read from env, never logged, never in the snapshot; CI uses the existing environment secret. Prefer a read-only role later.
- Snapshot staleness: a snapshot taken last week passes locally and fails in CI. Mitigated by the `--check` step in `check:local`, the manifest `taken_at` printed at load, and the scheduled job.
- Loader fidelity: generated columns (`tsv` on fees and features) must be skipped and recomputed; FK order matters; `truncate ... cascade` also empties `listing_sources`, `verification_*`, `source_snapshots` and `personal_*` detail tables locally (acceptable, they are not part of the MCP read path; say so in the script output).
- Hash false positives from number formatting: avoided by hashing canonical JS values on both sides.
- Diff churn: the snapshot is gitignored so it adds no diffs. Goldens still change when data changes; the semantic diff makes review small.
- Test mutation: tests that write to registry tables would poison local and make `verify-local` fail. Good: that is the detector.
- Docker and the local stack are required for `check:local`; agents without Docker still get CI.

## 6. Prototype loader (task A), ready to promote

Location (session scratchpad, not in the repo yet):
- `/private/tmp/claude-501/-Users-scottmacpherson-Documents-projects-bancadia-bancadia-app/dcd77f75-95f0-4d3b-9b14-229d1592fdd4/scratchpad/build-snapshot.py` turns a dev export (`{table: [rows]}`, or the MCP tool-result wrapper) into a data-only SQL script.
- `.../scratchpad/dev-snapshot.sql` is the generated script (about 525 KB). Load it with `docker exec -i supabase_db_bancadia-db psql -U postgres -v ON_ERROR_STOP=1 < dev-snapshot.sql`.

What the SQL does, in one transaction: `session_replication_role = replica`, `truncate` the 11 tables (reverse FK order, cascade), then for each table in FK order a `DO` block that builds the column list from `information_schema.columns where is_generated = 'NEVER'` and runs `insert ... select ... from jsonb_populate_recordset(null::public.<table>, <rows as jsonb>)`. Same uuids as dev. Numbers are kept as their original text. After loading, per-row hash comparison against dev matched on all 11 tables (0 differing rows).

To promote: port the Python to `load-snapshot.mjs` (read JSON, emit the same `DO` blocks or call `supabase-js` `rpc` with a small SQL function; plain `psql` via the `supabase_db_*` container works because the local stack already runs in Docker), and replace the MCP export step with the PostgREST fetch of `sync-from-dev.mjs`.
