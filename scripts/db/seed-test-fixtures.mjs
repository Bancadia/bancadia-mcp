// Seeds a fixed developer_api_tokens fixture for auth.integration.test.ts.
// bancadia-db's onboarding-scripts seed (applied by `supabase db reset
// --local`, which this script runs after — see package.json's db:reset)
// has no developer_api_tokens data: API tokens are an MCP-server concern,
// not a marketplace-listing concern, so this fixture is owned here instead
// of in bancadia-db.
//
// developer_api_tokens.developer_id -> developer_users.id -> auth.users.id
// (ON DELETE CASCADE), so a real auth.users row is required. Created via
// the admin API rather than raw SQL against GoTrue's internal schema, which
// this repo doesn't own and which can shift across Supabase CLI upgrades.
//
// Mirrored in src/__tests__/integration/auth.integration.test.ts — keep the
// raw token strings and fixed UUIDs in sync if either changes.
import { createClient } from '@supabase/supabase-js'
import { discoverSupabaseEnv } from './discover-env.mjs'

const FIXED_USER_ID = 'a0000000-0000-0000-0000-000000000001'
const FIXED_DEVELOPER_ID = 'b0000000-0000-0000-0000-000000000001'
const FIXED_ACTIVE_TOKEN_ID = 'c0000000-0000-0000-0000-000000000001'
const FIXED_REVOKED_TOKEN_ID = 'c0000000-0000-0000-0000-000000000002'
const FIXTURE_EMAIL = 'mcp-integration-test@bancadia.test'

// Raw token: mcp_integration_test_token_do_not_use_in_prod
const ACTIVE_TOKEN_HASH = '3b5fd5170aa2179d74526495b9238e551d710962212734726e421c9c8472392c'
// Raw token: mcp_integration_test_revoked_token
const REVOKED_TOKEN_HASH = '8c32ac948f6b990e5dd7548e422523f293623abedd0ec6a2b3ac3eb358fb59b4'

async function ensureAuthUser(admin) {
  const { data: existing } = await admin.auth.admin.getUserById(FIXED_USER_ID)
  if (existing?.user) return existing.user.id

  const { data, error } = await admin.auth.admin.createUser({
    id: FIXED_USER_ID,
    email: FIXTURE_EMAIL,
    password: crypto.randomUUID(),
    email_confirm: true,
  })
  if (error) {
    throw new Error(`Failed to create fixture auth user (${FIXTURE_EMAIL}): ${error.message}`)
  }
  return data.user.id
}

async function main() {
  const { apiUrl, serviceRoleKey } = discoverSupabaseEnv()
  const admin = createClient(apiUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const userId = await ensureAuthUser(admin)

  const { error: developerUserError } = await admin
    .from('developer_users')
    .upsert({ id: FIXED_DEVELOPER_ID, user_id: userId }, { onConflict: 'id' })
  if (developerUserError) {
    throw new Error(`Failed to upsert fixture developer_users row: ${developerUserError.message}`)
  }

  const { error: tokensError } = await admin.from('developer_api_tokens').upsert(
    [
      {
        id: FIXED_ACTIVE_TOKEN_ID,
        developer_id: FIXED_DEVELOPER_ID,
        token_name: 'mcp-integration-test-token',
        token_prefix: 'mcp_int_',
        token_hash: ACTIVE_TOKEN_HASH,
        revoked_at: null,
      },
      {
        id: FIXED_REVOKED_TOKEN_ID,
        developer_id: FIXED_DEVELOPER_ID,
        token_name: 'mcp-integration-test-revoked-token',
        token_prefix: 'mcp_int_',
        token_hash: REVOKED_TOKEN_HASH,
        revoked_at: new Date().toISOString(),
      },
    ],
    { onConflict: 'id' }
  )
  if (tokensError) {
    throw new Error(`Failed to upsert fixture developer_api_tokens rows: ${tokensError.message}`)
  }

  console.log('Seeded integration-test auth fixture (developer_api_tokens: 1 active, 1 revoked).')
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
