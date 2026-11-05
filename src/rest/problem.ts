import type { Context } from 'hono'

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
}

// RFC 9457 problem details. `detail` must never carry internals (500s pass a fixed string).
export function problem(c: Context, status: 400 | 401 | 404 | 429 | 500, detail: string, extra: Record<string, string> = {}) {
  return c.body(
    JSON.stringify({ type: 'about:blank', title: TITLES[status], status, detail }),
    status,
    { 'Content-Type': 'application/problem+json', ...extra }
  )
}
