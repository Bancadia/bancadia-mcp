export const APPLICATION_BASE_URL = 'https://bancadia.com'

export function toAbsoluteApplicationUrl(slug: string | null | undefined): string | null | undefined {
  if (!slug) return slug
  if (/^https?:\/\//i.test(slug)) return slug // already absolute — defensive, don't double-prepend
  return `${APPLICATION_BASE_URL}${slug.startsWith('/') ? '' : '/'}${slug}`
}

export function applyApplicationUrlHost<T extends object>(results: T[]): T[] {
  return results.map((row) => {
    if ('application_url' in row) {
      const value = (row as Record<string, unknown>).application_url
      if (typeof value === 'string') {
        return { ...row, application_url: toAbsoluteApplicationUrl(value) }
      }
    }
    return row
  })
}
