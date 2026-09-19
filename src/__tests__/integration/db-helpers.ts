import { env } from 'cloudflare:test'
import { createSupabaseClient } from '../../lib/supabase'
import type { Env } from '../../types'

// Real client against the local Docker Postgres -- env.SUPABASE_URL/
// SUPABASE_SECRET_KEY come from vitest.integration.config.mts's
// miniflare.bindings override, discovered from the running local Supabase
// instance by scripts/db/discover-env.mjs.
export function realSupabase() {
  return createSupabaseClient(env as Env)
}

// Resolves a real, current listing_id for a stable slug. Never assume a
// fixed UUID for onboarding-script data -- id regenerates every
// `supabase db reset --local` (gen_random_uuid() in those scripts).
export async function lookupListingIdBySlug(slug: string): Promise<string> {
  const { data, error } = await realSupabase()
    .from('business_deposit_accounts')
    .select('id')
    .eq('listing_slug', slug)
    .single()
  if (error || !data) {
    throw new Error(
      `Fixture listing_slug '${slug}' not found in local Supabase -- did you run ` +
        `\`npm run db:reset\`? (${error?.message})`
    )
  }
  return data.id
}
