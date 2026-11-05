import { Redis } from '@upstash/redis'
import { createSupabaseClient } from './supabase'
import type { Env } from '../types'

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

type CachedToken = { valid: boolean; developerId: string | null }

export type AuthResult =
  | { kind: 'anonymous' }
  | { kind: 'developer'; tokenHash: string; developerId: string | null }
  | { kind: 'invalid' }

// Header absent or empty = anonymous; a present-but-unknown/revoked token is
// 'invalid' (callers 401 rather than silently downgrading to anonymous).
export async function authenticate(request: Request, env: Env, ctx: ExecutionContext): Promise<AuthResult> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader) return { kind: 'anonymous' }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader.trim()
  if (!token) return { kind: 'anonymous' }

  const hash = await sha256hex(token)

  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  })

  const cached = await redis.get<CachedToken>(`token:${hash}`)
  if (cached !== null) {
    return cached.valid ? { kind: 'developer', tokenHash: hash, developerId: cached.developerId } : { kind: 'invalid' }
  }

  // Cache miss — query Supabase
  const supabase = createSupabaseClient(env)
  const { data } = await supabase
    .from('developer_api_tokens')
    .select('token_hash, developer_id')
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .single()

  const isValid = !!data
  const developerId = isValid ? ((data as { developer_id?: string }).developer_id ?? null) : null

  ctx.waitUntil(redis.set(`token:${hash}`, { valid: isValid, developerId }, { ex: 60 }))

  return isValid ? { kind: 'developer', tokenHash: hash, developerId } : { kind: 'invalid' }
}
