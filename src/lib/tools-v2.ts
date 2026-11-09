import manifest from '../../docs/v2-tool-manifest.json'

export const TOOLS_V2 = manifest.tools
export const V2_TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS_V2.map((t) => t.name))
export const profileOfTool = (name: string): 'legacy' | 'v2' => (V2_TOOL_NAMES.has(name) ? 'v2' : 'legacy')
