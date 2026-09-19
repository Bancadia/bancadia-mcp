// Discovers the running local Supabase instance's API URL and service-role
// key by shelling out to `supabase status -o json`, rather than hardcoding
// http://127.0.0.1:54321 + a guessed local JWT — robust to config.toml port
// changes and avoids drifting from whatever is actually running.
import { execFileSync } from 'node:child_process'

const BANCADIA_DB_PATH = process.env.BANCADIA_DB_PATH ?? '../bancadia-db'

export function discoverSupabaseEnv() {
  let raw
  try {
    raw = execFileSync(
      'npx',
      ['--no-install', 'supabase', '--workdir', BANCADIA_DB_PATH, 'status', '-o', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (err) {
    throw new Error(
      `Could not read local Supabase status from "${BANCADIA_DB_PATH}" ` +
        `(resolve with BANCADIA_DB_PATH env var if bancadia-db isn't a sibling directory).\n` +
        `Is it running? Try: npm run db:start\n\nUnderlying error: ${err.message}`
    )
  }

  let status
  try {
    status = JSON.parse(raw)
  } catch {
    throw new Error(`Unexpected output from "supabase status -o json":\n${raw}`)
  }

  const { API_URL, SERVICE_ROLE_KEY } = status
  if (!API_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      `"supabase status -o json" did not include API_URL/SERVICE_ROLE_KEY. Got: ${raw}`
    )
  }

  return { apiUrl: API_URL, serviceRoleKey: SERVICE_ROLE_KEY }
}

export { BANCADIA_DB_PATH }
