import { createClient } from '@supabase/supabase-js'
import type { Env } from '../types'
import type { Database } from './database.types'

// Per-request factory — no module-level singleton (stateless Workers isolates)
export function createSupabaseClient(env: Env) {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  })
}
