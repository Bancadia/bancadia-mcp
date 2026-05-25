import { createClient } from '@supabase/supabase-js'
import type { Env } from '../types'

// Per-request factory — no module-level singleton (stateless Workers isolates)
export function createSupabaseClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
}
