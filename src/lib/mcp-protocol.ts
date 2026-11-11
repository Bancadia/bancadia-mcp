// MCP protocol lifecycle versions this server understands, newest first.
// Shared by the stateful `/` endpoint and the stateless `/chatgpt/mcp` endpoint.
export const LATEST_PROTOCOL_VERSION = '2025-06-18'
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-03-26', '2024-11-05']

export const negotiateProtocolVersion = (requested: unknown): string =>
  typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION
