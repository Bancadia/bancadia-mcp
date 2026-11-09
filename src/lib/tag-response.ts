import { tagApplicationUrl, toAbsoluteApplicationUrl, APPLICATION_BASE_URL, type ApplicationUrlTags } from './urls'

type Row = Record<string, unknown>
type Payload = any // eslint-disable-line @typescript-eslint/no-explicit-any

// Bank-bearing rows per tool (matches_overview is deliberately not included: no links by design).
const ROW_KEYS: Record<string, string[]> = {
  list_business_checking: ['rows', 'possible_matches'],
  search_facts: ['hits', 'no_match'],
  get_listing: ['listings'],
}

function bankRows(tool: string, p: Payload): Row[] {
  if (tool === 'fees_by_type') return Array.isArray(p) ? p : []
  return (ROW_KEYS[tool] ?? []).flatMap((k) => (Array.isArray(p?.[k]) ? p[k] : []))
}

const tagRow = (r: Row, tags: ApplicationUrlTags): Row =>
  typeof r.application_url === 'string'
    ? { ...r, application_url: tagApplicationUrl(toAbsoluteApplicationUrl(r.application_url) as string, tags) }
    : r

export function assertAllTagged(tool: string, payload: Payload): void {
  for (const r of bankRows(tool, payload)) {
    const u = r.application_url
    let ok = false
    if (typeof u === 'string' && u.startsWith(`${APPLICATION_BASE_URL}/`)) {
      try {
        const q = new URL(u).searchParams
        ok = !!q.get('src') && !!q.get('qr')
      } catch { /* not a URL */ }
    }
    if (!ok) throw new Error(`untagged application_url in ${tool}: ${String(r.slug ?? r.listing_slug)}`)
  }
}

// Host-prefix + tag every bank-bearing row, then assert (a throw is a server error, never an untagged payload).
export function tagResponse(tool: string, payload: Payload, tags: ApplicationUrlTags): Payload {
  let out = payload
  if (tool === 'fees_by_type') out = Array.isArray(payload) ? payload.map((r) => tagRow(r, tags)) : payload
  else {
    out = { ...payload }
    for (const k of ROW_KEYS[tool] ?? []) if (Array.isArray(out[k])) out[k] = out[k].map((r: Row) => tagRow(r, tags))
  }
  assertAllTagged(tool, out)
  return out
}
