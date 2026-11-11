import { describe, it, expect } from 'vitest'
import { activeListings } from './v2-helpers'
import { LISTING_SLUGS } from '../../chatgpt/tools'

// Proves: the slug list shown to ChatGPT (get_listing's `slugs` description) is the registry's active business
// checking listings. A listing added or paused in the database fails this test until src/chatgpt/tools.ts
// LISTING_SLUGS is updated, so the hand-maintained list cannot silently go stale.
describe('ChatGPT listing slug list matches the database', () => {
  it('LISTING_SLUGS equals the active business checking listing_slugs', async () => {
    const live = (await activeListings()).map((l) => l.listing_slug).sort()
    expect({
      add_to_LISTING_SLUGS: live.filter((s) => !LISTING_SLUGS.includes(s)),
      remove_from_LISTING_SLUGS: LISTING_SLUGS.filter((s) => !live.includes(s)),
    }).toEqual({ add_to_LISTING_SLUGS: [], remove_from_LISTING_SLUGS: [] })
  })
})
