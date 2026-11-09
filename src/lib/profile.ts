import type { Env } from '../types'

export type Profile = 'legacy' | 'v2'

export const PROFILE_HEADER = 'X-Bancadia-Profile'

const parse = (v: unknown): Profile | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return s === 'legacy' || s === 'v2' ? s : null
}

export const envProfile = (env: Env): Profile => parse(env.MCP_PROFILE) ?? 'legacy'

// Read once at initialize: header wins over ?profile=; invalid values are ignored (env default).
export function resolveProfile(req: Request, env: Env): Profile {
  return parse(req.headers.get(PROFILE_HEADER)) ?? parse(new URL(req.url).searchParams.get('profile')) ?? envProfile(env)
}

// Sessions created before profiles existed follow the env default.
export const effectiveProfile = (record: { profile?: string } | undefined, env: Env): Profile =>
  parse(record?.profile) ?? envProfile(env)
