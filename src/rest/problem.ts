import type { Context } from 'hono'

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
}

export type ProblemStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500

// RFC 9457 problem details. `detail` must never carry internals (500s pass a fixed string).
export function problem(c: Context, status: ProblemStatus, detail: string, extra: Record<string, string> = {}) {
  return c.body(
    JSON.stringify({ type: 'about:blank', title: TITLES[status], status, detail }),
    status,
    { 'Content-Type': 'application/problem+json', ...extra }
  )
}
