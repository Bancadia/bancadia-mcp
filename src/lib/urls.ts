export const APPLICATION_BASE_URL = 'https://bancadia.com'

// Attribution tags appended to every application_url an MCP tool returns, so
// bancadia-app's /go route can tell an MCP-delivered click apart from other
// surfaces (`src`) and join it back to the tool call that produced it (`qr`
// = query_match_events.request_id). See bancadia-app
// docs/plans/go-click-attribution.md §3.2.
export type ApplicationUrlTags = Record<string, string | null | undefined>

export function toAbsoluteApplicationUrl(slug: string | null | undefined): string | null | undefined {
  if (!slug) return slug
  if (/^https?:\/\//i.test(slug)) return slug // already absolute — defensive, don't double-prepend
  return `${APPLICATION_BASE_URL}${slug.startsWith('/') ? '' : '/'}${slug}`
}

// Merges `tags` into the URL's query string. Never overwrites a param the URL
// already carries (so a stored `src`/`utm_*` wins), skips null/empty tag
// values, and preserves any fragment. A value that doesn't parse as an
// absolute URL is returned unchanged rather than mangled.
export function tagApplicationUrl(url: string, tags: ApplicationUrlTags): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let changed = false
  for (const [key, value] of Object.entries(tags)) {
    if (value === null || value === undefined || value === '') continue
    if (parsed.searchParams.has(key)) continue
    parsed.searchParams.append(key, value)
    changed = true
  }
  return changed ? parsed.toString() : url
}

// Single post-handler layer (called from index.ts for every tools/call
// result) that turns stored relative application_url paths into absolute
// URLs on the public host and then appends the attribution tags. Doing both
// here, rather than in each handler's mapper, means every tool — including
// any newly wired one — is host-prefixed and tagged identically.
export function applyApplicationUrlHost<T extends object>(results: T[], tags: ApplicationUrlTags = {}): T[] {
  return results.map((row) => {
    if ('application_url' in row) {
      const value = (row as Record<string, unknown>).application_url
      if (typeof value === 'string') {
        const absolute = toAbsoluteApplicationUrl(value)
        return { ...row, application_url: absolute ? tagApplicationUrl(absolute, tags) : absolute }
      }
    }
    return row
  })
}
