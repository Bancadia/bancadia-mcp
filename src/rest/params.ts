type Prop = { type?: string }
type InputSchema = { properties?: Record<string, Prop | undefined> }

const MAX_ARRAY_ITEMS = 50
const MAX_VALUE_LENGTH = 200
const DECIMAL = /^-?\d+(\.\d+)?$/

// Parses URL query params into tool args per the declared property types.
// number: plain decimal only; boolean: 'true'|'false'; array: comma-separated; string: as-is.
// Enum/required checks are left to validateArgs(). Unknown keys are errors.
export function parseQueryParams(
  searchParams: URLSearchParams,
  inputSchema: InputSchema
): { args: Record<string, unknown> } | { error: string } {
  const props = inputSchema.properties ?? {}
  const args: Record<string, unknown> = {}
  for (const key of new Set(searchParams.keys())) {
    const prop = props[key]
    if (!prop) {
      return { error: `Unknown query parameter '${key}'. Valid parameters: ${Object.keys(props).join(', ')}` }
    }
    const values = searchParams.getAll(key)
    if (values.some((v) => v.length > MAX_VALUE_LENGTH)) {
      return { error: `Query parameter '${key}' is too long (max ${MAX_VALUE_LENGTH} characters per value)` }
    }
    if (prop.type === 'array') {
      const items = values.flatMap((v) => (v === '' ? [] : v.split(',')))
      if (items.length > MAX_ARRAY_ITEMS) {
        return { error: `Query parameter '${key}' has too many items (max ${MAX_ARRAY_ITEMS})` }
      }
      args[key] = items
      continue
    }
    if (values.length > 1) return { error: `Query parameter '${key}' must be given once` }
    const raw = values[0]!
    if (prop.type === 'number') {
      const n = DECIMAL.test(raw) ? Number(raw) : NaN
      if (!Number.isFinite(n)) return { error: `Invalid parameter '${key}': expected a finite decimal number` }
      args[key] = n
    } else if (prop.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') return { error: `Invalid parameter '${key}': expected true or false` }
      args[key] = raw === 'true'
    } else {
      args[key] = raw
    }
  }
  return { args }
}
