type PropSchema = { type?: string; enum?: readonly string[]; items?: PropSchema }
type InputSchema = { properties?: Record<string, PropSchema | undefined>; required?: readonly string[] }

function checkValue(value: unknown, schema: PropSchema): string | null {
  switch (schema.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'a finite number'
      break
    case 'boolean':
      if (typeof value !== 'boolean') return 'a boolean'
      break
    case 'string':
      if (typeof value !== 'string') return 'a string'
      break
    case 'array': {
      if (!Array.isArray(value)) return 'an array'
      const bad = schema.items ? value.find((v) => checkValue(v, schema.items!) !== null) : undefined
      if (bad !== undefined) return `an array whose items are each ${checkValue(bad, schema.items!)}`
      break
    }
  }
  if (schema.enum && !schema.enum.includes(value as string)) return `one of: ${schema.enum.join(', ')}`
  return null
}

// Checks declared properties only (type, enum, required); undeclared extra
// args are tolerated, matching the handlers. Returns a message or null.
export function validateArgs(args: Record<string, unknown>, schema: InputSchema): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `Missing required argument: ${key}`
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!prop || args[key] === undefined) continue
    const expected = checkValue(args[key], prop)
    if (expected) return `Invalid argument '${key}': expected ${expected}`
  }
  return null
}
