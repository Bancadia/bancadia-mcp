import { configDefaults, defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  test: {
    // Real-DB integration tests live under their own config/npm script
    // (vitest.integration.config.mts / `npm run test:integration`) so the
    // default `npm test` stays fast, fully mocked, and Docker-free.
    exclude: [...configDefaults.exclude, 'src/__tests__/integration/**'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
})
