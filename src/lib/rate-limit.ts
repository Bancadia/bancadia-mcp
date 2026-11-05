import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { Env } from '../types'

// key is `token:<hash>` or `ip:<addr>`; anonymous callers use the ANON_* limits.
export async function rateLimit(
  env: Env,
  key: string,
  kind: 'anonymous' | 'developer'
): Promise<{ success: boolean; limit: number; remaining: number; reset: number }> {
  const anon = kind === 'anonymous'
  const limit = parseInt((anon ? env.ANON_RATE_LIMIT_REQUESTS : env.RATE_LIMIT_REQUESTS) ?? (anon ? '60' : '100'))
  const window = parseInt(
    (anon ? env.ANON_RATE_LIMIT_WINDOW_SECONDS : env.RATE_LIMIT_WINDOW_SECONDS) ?? '60'
  )
  const ratelimit = new Ratelimit({
    redis: new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }),
    limiter: Ratelimit.slidingWindow(limit, `${window} s`),
    prefix: 'rl',
  })
  const { success, limit: rlLimit, remaining, reset } = await ratelimit.limit(key)
  return { success, limit: rlLimit, remaining, reset }
}
