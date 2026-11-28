---
name: sync-dev-and-local-db
description: Sync Bancadia listing data from prod to dev, then from dev to the local Supabase database. Use when the user says dev or local data is out of date, asks to copy prod data to dev, run db:fresh, or refresh local from dev/prod.
---

# Sync prod -> dev -> local

Two stages, always in this order. Run everything from the `bancadia-mcp` repo root.

| Stage | Script | Direction | Touches |
|---|---|---|---|
| 1 | `scripts/local/sync-listing.mjs` | prod -> dev | dev, through the admin API (`/v1/listings`). Prod is only read. |
| 2 | `npm run db:fresh` | dev -> local | local Supabase. **Wipes it** (`supabase db reset`). |

Ask the user which listing slug(s) to sync, or whether to use `--all`. Never guess a slug. Skip stage 1 if the user only wants local refreshed from dev, and skip stage 2 if they only want dev updated.

## Rules

- **Never read, print, `cat`, `grep` or decode `scripts/local/sync.env`, `.env` or `.dev.vars` values, and never ask the user to paste a token.** Token problems are detected from the script's error, not by inspecting the files. Checking that a file exists (`ls`) is fine.
- Always do the dry run before `--yes`, and show the user the diff before applying.
- Dev is the only thing stage 1 writes to. Never point `SYNC_DEV_URL` at prod (the script refuses if both URLs match).
- Stage 2 destroys local data. Say so before running it.

## Stage 0: prerequisites

1. `ls scripts/local/sync.env`. If missing, tell the user to `cp scripts/local/sync.env.example scripts/local/sync.env` and fill in `SYNC_PROD_URL` (`https://api.bancadia.com/v1`), `SYNC_DEV_URL` (the Worker whose `SUPABASE_URL` is the dev project), `SYNC_PROD_TOKEN`, `SYNC_DEV_TOKEN`. Tokens come from the section below.
2. For stage 2: Docker is running and local Supabase is up (`npm run db:start`), and `DEV_SUPABASE_SECRET_KEY` is set in the git-ignored `.env`. If `db:fresh` complains it is missing, tell the user to add it. Do not read `.env`.

## Stage 1: prod -> dev

```bash
node scripts/local/sync-listing.mjs <listing-slug>          # dry run, writes nothing
node scripts/local/sync-listing.mjs <listing-slug> --yes    # apply, then it re-reads dev and verifies it matches prod
node scripts/local/sync-listing.mjs --all                   # dry run for every prod listing that also exists in dev
node scripts/local/sync-listing.mjs --all --yes
```

1. Run the dry run. Summarize what would change. It should only reflect the edits made in prod. A big diff with deletes of rows nobody touched means the wrong URLs or heavily drifted dev: stop and ask.
2. After the user agrees, run with `--yes`.
3. It can take minutes: one HTTP call per row, with backoff on 429 (honors `Retry-After`, 6 retries). If it ends in `-> 429`, wait a minute and re-run; it converges because it diffs against current dev.
4. If the verify step reports a mismatch, re-run once.

Limits to tell the user if relevant: the listing must already exist in dev (matched by slug); `listing_status`, publish schedule and verification flags are not synced; changed child rows are deleted and recreated so their dev UUIDs change.

### If the script fails with 401 or 403 (expired or wrong token)

Admin tokens expire (`--days`, max 365) and can be revoked. A 401 on a `GET` means a bad or expired token; 403 on a write means a read-scope token was used for dev. Work out which side failed from the error text (prod calls are reads, dev calls are writes), then give the user the exact commands below. Print only the commands for the environment that failed, unless both did.

Each token must be minted against the database whose Worker will check it. The only placeholder is the secret key, which the user gets from that project's Supabase dashboard (API keys).

**Prod token (read scope), run from the `bancadia-mcp` repo root:**
```bash
SUPABASE_URL=https://whdgajougioxiwotnwva.supabase.co \
SUPABASE_SECRET_KEY=<SUPABASE_SECRET_KEY> \
node scripts/create-admin-token.mjs --name sync-prod --scope read --days 30 --yes
```
Then put the printed token in `scripts/local/sync.env` as `SYNC_PROD_TOKEN`.

**Dev token (write scope), run from the `bancadia-mcp` repo root:**
```bash
SUPABASE_URL=https://qbotkqtlyovicrpranqr.supabase.co \
SUPABASE_SECRET_KEY=<SUPABASE_SECRET_KEY> \
node scripts/create-admin-token.mjs --name sync-dev --scope write --days 30 --yes
```
Then put the printed token in `scripts/local/sync.env` as `SYNC_DEV_TOKEN`.

Tell the user:
- The script prints the host it writes to. It must read `whdgajougioxiwotnwva.supabase.co` for prod and `qbotkqtlyovicrpranqr.supabase.co` for dev. If not, stop.
- The raw token is shown once; only its hash is stored.
- `--name` must be unique per token. If the name is already taken, use a new one (e.g. `sync-dev-2`).
- Do not use `--env-file=.dev.vars`: that points at the local database, so the token would be useless against dev or prod.
- Prod gets the **read** token and dev gets the **write** token. Do not swap them.
- To revoke an old one: `UPDATE admin_api_tokens SET revoked_at = now() WHERE name = '<name>';` against that database.

After they confirm `sync.env` is updated, re-run the failed command.

## Stage 2: dev -> local

Warn first: this wipes the local database and rebuilds it as a copy of dev.

```bash
npm run db:fresh
npm run test:integration
```

`db:fresh` = `db:sync-from-dev` (writes `../bancadia-db/supabase/seeds/dev-data.sql` and `dev-enums.sql` from dev's registry tables) then `db:reset` (migrations, the two seeds, grants, test fixtures).

The enum seed (`dev-enums.sql`, listed first in `bancadia-db/supabase/config.toml`) replays every dev enum label through `admin_add_enum_value`. That is what stops enum values added to dev through the admin API but missing from migrations from breaking the seed. It only covers the enum columns of the admin resources (details, fees, features, promotions, plan-tiers, target-segments, integrations).

### Troubleshooting

- **`invalid input value for enum ...` (22P02) during seed:** the enum is outside the seven admin resources, or the seed files are stale. Re-run `npm run db:sync-from-dev`. If it still fails, find the missing labels and add a numbered migration in `../bancadia-db/supabase/migrations/` with `ALTER TYPE <enum> ADD VALUE IF NOT EXISTS '<label>';` (compare `admin_field_enums(<resource>)` on dev against local: `docker exec supabase_db_bancadia-db psql -U postgres -At -c "select admin_field_enums('fees')"`).
- **`unsafe use of new value ... (55P04)`:** an enum add and its use ended up in the same seed batch. Keep `dev-enums.sql` as its own file, before `dev-data.sql`.
- **`Missing ... Run: npm run db:sync-from-dev`:** run it (needs `DEV_SUPABASE_SECRET_KEY` in `.env`).
- **Integration test fails only because dev's data changed:** update the test or golden with `npm run capture:goldens`. Do not edit seeds to make local match a test.

## Finish

Report: which listings were synced, whether the stage-1 verify passed, that local was rebuilt, and the `test:integration` result (say plainly if it failed or was skipped). Nothing here commits anything; if `../bancadia-db` has new migrations or `config.toml` changes, remind the user they are uncommitted.
