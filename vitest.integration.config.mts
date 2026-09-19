import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// Real local Supabase instance, not mocked — see scripts/db/ and
// docs/current-testing-flow.md. Run via `npm run test:integration`, never
// picked up by plain `npm test` (different filename than vitest.config.*'s
// default discovery, and vitest.config.mts additionally excludes this
// suite's directory).
export default defineConfig({
  test: {
    include: ['src/__tests__/integration/**/*.test.ts'],
    // Integration test files share one live Postgres instance and mutate
    // shared tables (query_match_events) — keep them serialized rather than
    // introducing per-test isolation machinery for a handful of files.
    fileParallelism: false,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          SUPABASE_URL: process.env.SUPABASE_URL,
          SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
        },
      },
    }),
  ],
})
