// Prints the v2 token budgets (docs/v2-tool-spec.md section 8) for a running Worker.
// Usage: node scripts/measure-tokens.mjs [baseUrl]   (default http://localhost:8787, e.g. `npm run dev`)
// tokens ~= chars / 2.6 (calibrated on the legacy manifest = 2.7k tokens).
const base = process.argv[2] ?? 'http://localhost:8787'
const approx = (s) => Math.ceil(s.length / 2.6)
const post = (body, headers = {}) =>
  fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })

const init = await post({ method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { 'X-Bancadia-Profile': 'v2' })
const session = init.headers.get('Mcp-Session-Id')
if (!session) throw new Error(`initialize failed: ${init.status}`)
const h = { 'Mcp-Session-Id': session }

const list = (await (await post({ method: 'tools/list' }, h)).json()).result.tools
const schemaChars = JSON.stringify(list).length
console.log(`v2 tools/list: ${schemaChars} chars = ${approx(JSON.stringify(list))} tokens (budget 2200)`)

const call = await (await post({ method: 'tools/call', params: { name: 'list_business_checking', arguments: {} } }, h)).json()
const text = call.result.content[0].text
console.log(`default list (7 rows, tagged): ${text.length} chars = ${approx(text)} tokens (budget 5000)`)
