type Prop = { type?: string }
type InputSchema = { properties?: Record<string, Prop | undefined> }

// Parses URL query params into tool args per the declared property types.
// number: finite; boolean: 'true'|'false'; array: comma-separated; string: as-is.
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
    if (prop.type === 'array') {
      args[key] = values.flatMap((v) => (v === '' ? [] : v.split(',')))
      continue
    }
    if (values.length > 1) return { error: `Query parameter '${key}' must be given once` }
    const raw = values[0]!
    if (prop.type === 'number') {
      const n = raw.trim() === '' ? NaN : Number(raw)
      if (!Number.isFinite(n)) return { error: `Invalid parameter '${key}': expected a finite number` }
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
