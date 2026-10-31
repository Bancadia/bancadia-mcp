// Resolves the Supabase URL + secret key the integration tooling targets:
// SUPABASE_URL/SUPABASE_SECRET_KEY from process.env (CI, or a one-off shell
// override), else the same keys from the git-ignored .dev.vars (local).
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const BANCADIA_DB_PATH = process.env.BANCADIA_DB_PATH ?? '../bancadia-db'

// The suite writes rows, so refuse anything that could be production.
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', 'qbotkqtlyovicrpranqr.supabase.co']

export function discoverSupabaseEnv() {
  let apiUrl = process.env.SUPABASE_URL
  let serviceRoleKey = process.env.SUPABASE_SECRET_KEY
  if (!apiUrl || !serviceRoleKey) {
    const devVars = existsSync('.dev.vars') ? parseEnv(readFileSync('.dev.vars', 'utf8')) : {}
    apiUrl = devVars.SUPABASE_URL
    serviceRoleKey = devVars.SUPABASE_SECRET_KEY
  }
  if (!apiUrl || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the environment or in .dev.vars. ' +
        'For a local instance, start it with: npm run db:start'
    )
  }

  let host
  try {
    host = new URL(apiUrl).hostname
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: ${apiUrl}`)
  }
  if (!ALLOWED_HOSTS.includes(host)) {
    throw new Error(
      `Refusing to run integration tooling against "${host}". Allowed hosts: ${ALLOWED_HOSTS.join(', ')}.`
    )
  }

  return { apiUrl, serviceRoleKey }
}

export { BANCADIA_DB_PATH }
