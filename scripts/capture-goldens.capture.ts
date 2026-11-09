// Captures legacy-profile goldens into src/__tests__/__golden__/ against the LOCAL Supabase.
// Run: npm run capture:goldens   (after db:reset). Never run against dev/prod.
import { it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { TOOLS } from '../src/lib/tools'
import { handleQueryBusinessChecking } from '../src/handlers/query-business-checking'
import { handleGetBusinessCheckingListing } from '../src/handlers/get-business-checking-listing'
import { applyApplicationUrlHost } from '../src/lib/urls'
import { CANNED_LIST_QUERIES, CANNED_GET_SLUGS, normalizeForGolden } from '../src/__tests__/golden-normalize'

const dir = 'src/__tests__/__golden__'
it('capture', async () => {
  const vars = parseEnv(readFileSync('.dev.vars', 'utf8'))
  if (!/127\.0\.0\.1|localhost/.test(vars.SUPABASE_URL ?? '')) throw new Error('refusing: not local')
  const env = { SUPABASE_URL: vars.SUPABASE_URL, SUPABASE_SECRET_KEY: vars.SUPABASE_SECRET_KEY } as never
  const ctx = { waitUntil() {}, passThroughOnException() {} } as never
  const meta = { toolName: 'x', developerId: null, channel: 'mcp', sessionId: 's', userAgent: null, requestId: 'r' } as never
  const tag = { src: 'mcp', qr: '00000000-0000-4000-8000-000000000000' }
  writeFileSync(`${dir}/legacy-tools-list.json`, JSON.stringify({ tools: TOOLS }))
  const out: Record<string, unknown> = {}
  for (const [name, args] of Object.entries(CANNED_LIST_QUERIES))
    out[`query:${name}`] = normalizeForGolden(applyApplicationUrlHost(await handleQueryBusinessChecking(args, env, ctx, meta), tag))
  for (const slug of CANNED_GET_SLUGS)
    out[`get:${slug}`] = normalizeForGolden(
      applyApplicationUrlHost(await handleGetBusinessCheckingListing({ listing_slug: slug }, env, ctx, meta), tag)
    )
  writeFileSync(`${dir}/legacy-tool-outputs.json`, JSON.stringify(out, null, 1) + '\n')
})
