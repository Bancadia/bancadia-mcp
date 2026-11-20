import type { Env } from '../types'
import { sha256hex } from '../lib/auth'
import { createSupabaseClient } from '../lib/supabase'

// Who is calling the admin API. `label` is what lands in listing_audits.actor_email.
export type Actor = { kind: 'user' | 'token'; id: string; label: string; scope: 'read' | 'write' }

export type AdminAuth = { ok: true; actor: Actor } | { ok: false; status: 401 | 403; detail: string }

const DENY_401: AdminAuth = { ok: false, status: 401, detail: 'Missing, invalid or expired credentials.' }
const DENY_403: AdminAuth = { ok: false, status: 403, detail: 'This credential is not authorized for the admin API.' }
const TOKEN_PREFIX = 'sk_admin_'

// Two credentials, deliberately uncached so revocation and sign-out take effect on the next request:
//   Authorization: Bearer sk_admin_...   a row in admin_api_tokens (hashed; scope read|write; expires/revoked)
//   Authorization: Bearer <Supabase JWT> a Supabase user that has a row in admin_users
// 401 = no/invalid credential. 403 = valid credential that is not an admin.
export async function authenticateAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<AdminAuth> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return DENY_401

  const db = createSupabaseClient(env)

  if (token.startsWith(TOKEN_PREFIX)) {
    const { data, error } = await db
      .from('admin_api_tokens')
      .select('id, name, scope, expires_at, revoked_at')
      .eq('token_hash', await sha256hex(token))
      .maybeSingle()
    if (error) throw error
    if (!data || data.revoked_at || (data.expires_at && Date.parse(data.expires_at) <= Date.now())) return DENY_401
    ctx.waitUntil(
      Promise.resolve(db.from('admin_api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id))
    )
    return { ok: true, actor: { kind: 'token', id: data.id, label: `token:${data.name}`, scope: data.scope === 'write' ? 'write' : 'read' } }
  }

  const { data: userData, error: userError } = await db.auth.getUser(token)
  if (userError || !userData.user) return DENY_401
  const { data: row, error } = await db.from('admin_users').select('user_id').eq('user_id', userData.user.id).maybeSingle()
  if (error) throw error
  if (!row) return DENY_403
  return { ok: true, actor: { kind: 'user', id: userData.user.id, label: userData.user.email ?? userData.user.id, scope: 'write' } }
}
