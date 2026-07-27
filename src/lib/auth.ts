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

export async function authenticate(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<{ valid: boolean; tokenHash: string | null; developerId: string | null }> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader) {
    return { valid: false, tokenHash: null, developerId: null }
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : authHeader.trim()
  if (!token) {
    return { valid: false, tokenHash: null, developerId: null }
  }

  const hash = await sha256hex(token)

  const redis = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  })

  const cached = await redis.get<CachedToken>(`token:${hash}`)
  if (cached !== null) {
    return {
      valid: cached.valid,
      tokenHash: cached.valid ? hash : null,
      developerId: cached.valid ? cached.developerId : null,
    }
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

  return { valid: isValid, tokenHash: isValid ? hash : null, developerId }
}
