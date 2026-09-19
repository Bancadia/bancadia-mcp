// Discovers the local Supabase instance's URL/service-role key and runs the
// integration suite against it, injected as env vars that
// vitest.integration.config.mts reads (Node-side) and forwards into the
// Worker's bindings — src/lib/supabase.ts itself never changes.
import { spawnSync } from 'node:child_process'
import { discoverSupabaseEnv } from './discover-env.mjs'

const { apiUrl, serviceRoleKey } = discoverSupabaseEnv()

const result = spawnSync(
  'npx',
  ['--no-install', 'vitest', 'run', '--config', 'vitest.integration.config.mts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      SUPABASE_URL: apiUrl,
      SUPABASE_SECRET_KEY: serviceRoleKey,
    },
  }
)

process.exit(result.status ?? 1)
