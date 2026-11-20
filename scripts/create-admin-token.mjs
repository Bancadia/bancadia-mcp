#!/usr/bin/env node
// Creates an admin API token for /v1/listings/* (e.g. the future validation tool).
//
// This is the ONLY way to mint one: no API endpoint, UI or migration can, so no secret lands in git and a leaked
// token can never create more tokens. The raw token is printed once and only its SHA-256 hash is stored.
//
//   node --env-file=.dev.vars scripts/create-admin-token.mjs --name validator --scope read --days 90 --yes
//
//   --name   label shown in the audit trail as "token:<name>" (required)
//   --scope  read (GET only, default) or write
//   --days   lifetime in days (default 90, max 365)
//   --yes    required; without it the script only prints which database it would write to
//
// Writes to whatever SUPABASE_URL points at, so check the host it prints. Revoke with:
//   UPDATE admin_api_tokens SET revoked_at = now() WHERE name = '<name>';
import { createHash, randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    scope: { type: 'string', default: 'read' },
    days: { type: 'string', default: '90' },
    yes: { type: 'boolean', default: false },
  },
})

const fail = (msg) => {
  console.error(`error: ${msg}`)
  process.exit(1)
}

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) fail('SUPABASE_URL and SUPABASE_SECRET_KEY must be set (e.g. node --env-file=.dev.vars ...)')
if (!values.name || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(values.name)) fail('--name is required (letters, digits, . _ -; max 64)')
if (!['read', 'write'].includes(values.scope)) fail('--scope must be read or write')
const days = Number(values.days)
if (!Number.isInteger(days) || days < 1 || days > 365) fail('--days must be an integer between 1 and 365')

const host = new URL(SUPABASE_URL).host
console.error(`database: ${host}\nname: ${values.name}  scope: ${values.scope}  expires in: ${days} days`)
if (!values.yes) fail('re-run with --yes to create the token')

const token = `sk_admin_${randomBytes(32).toString('base64url')}`
const row = {
  name: values.name,
  token_prefix: token.slice(0, 16),
  token_hash: createHash('sha256').update(token).digest('hex'),
  scope: values.scope,
  expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/admin_api_tokens`, {
  method: 'POST',
  headers: {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  },
  body: JSON.stringify(row),
})
if (!res.ok) fail(`insert failed: ${res.status} ${await res.text()}`)

console.error('created. Copy the token now; it cannot be shown again:\n')
console.log(token)
