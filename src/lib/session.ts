import { Redis } from '@upstash/redis'
import type { Env } from '../types'

export const SESSION_HEADER = 'Mcp-Session-Id'

const DEFAULT_TTL_SECONDS = 1800

export interface SessionRecord {
  protocolVersion: string
  createdAt: number
}

export type SessionValidation =
  | { ok: true; sessionId: string; record: SessionRecord }
  | { ok: false; status: 400 | 404 }

function redisClient(env: Env): Redis {
  return new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
}

function ttlSeconds(env: Env): number {
  return parseInt(env.SESSION_TTL_SECONDS ?? String(DEFAULT_TTL_SECONDS))
}

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`
}

export async function createSession(
  env: Env,
  protocolVersion: string
): Promise<string> {
  const sessionId = crypto.randomUUID()
  const record: SessionRecord = { protocolVersion, createdAt: Date.now() }
  await redisClient(env).set(sessionKey(sessionId), record, { ex: ttlSeconds(env) })
  return sessionId
}

export async function getSession(env: Env, sessionId: string): Promise<SessionRecord | null> {
  const record = await redisClient(env).get<SessionRecord>(sessionKey(sessionId))
  return record ?? null
}

// Sliding expiry: bump the TTL without rewriting the record. Fire-and-forget
// via ctx.waitUntil — a missed refresh just makes the session expire a
// little earlier than the full window next time, which isn't worth blocking
// the response for.
export function touchSession(env: Env, ctx: ExecutionContext, sessionId: string): void {
  ctx.waitUntil(redisClient(env).expire(sessionKey(sessionId), ttlSeconds(env)))
}

export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await redisClient(env).del(sessionKey(sessionId))
}

// Session validation happens once, at the start of request handling. A
// session that goes idle-expired *during* a long-running tools/call does not
// abort that in-flight call — it simply won't validate on the next request.
export async function validateSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<SessionValidation> {
  const sessionId = request.headers.get(SESSION_HEADER)
  if (!sessionId) {
    return { ok: false, status: 400 }
  }

  const record = await getSession(env, sessionId)
  if (!record) {
    return { ok: false, status: 404 }
  }

  touchSession(env, ctx, sessionId)
  return { ok: true, sessionId, record }
}
