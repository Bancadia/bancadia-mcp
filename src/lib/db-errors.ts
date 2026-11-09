// SQLSTATE 22023 (invalid_parameter_value) messages list the valid values and are safe to show; nothing else is.
export function mapDbError(error: { message: string; code?: string }): { kind: 'invalid_args'; message: string } | { kind: 'error' } {
  return error.code === '22023' ? { kind: 'invalid_args', message: error.message } : { kind: 'error' }
}
