// Applies scripts/db/grants.sql (see that file for why this is needed) to
// the local Supabase instance. Run as separate single-statement calls
// because `supabase db query --local -f <file>` rejects multi-statement
// files ("cannot insert multiple commands into a prepared statement").
import { execFileSync } from 'node:child_process'
import { BANCADIA_DB_PATH } from './discover-env.mjs'

const STATEMENTS = [
  'GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;',
  'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;',
]

for (const sql of STATEMENTS) {
  execFileSync(
    'npx',
    ['--no-install', 'supabase', '--workdir', BANCADIA_DB_PATH, 'db', 'query', '--local', sql],
    { stdio: 'inherit' }
  )
}

console.log('Applied local-only corrective grants (see scripts/db/grants.sql).')
