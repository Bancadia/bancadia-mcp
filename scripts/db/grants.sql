-- Local-only corrective grant, applied after `supabase db reset --local`
-- (see package.json's db:reset). On a freshly-reset local Supabase CLI
-- instance, `anon`/`authenticated`/`service_role` end up with only
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on public-schema tables (no
-- SELECT/INSERT/UPDATE/DELETE) -- confirmed reproducible from a clean
-- `supabase stop --no-backup` + `start` + `db reset --local`, and NOT
-- caused by any bancadia-db migration (none of the 48 touch GRANT or
-- DEFAULT PRIVILEGES). Root cause: bancadia-db's migrations run as the
-- `postgres` role locally, whose own default-ACL for the public schema is
-- narrower than `supabase_admin`'s (the role the platform's own bootstrap
-- grants against). Scoped to bancadia-mcp's local test tooling only --
-- not applied to bancadia-db itself, since it's unconfirmed whether this
-- also affects the hosted project (verify there independently if this
-- surfaces again).
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
