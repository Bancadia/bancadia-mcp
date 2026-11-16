import { createSurface } from '../lib/surface'
import { TOOL_LIST } from '../chatgpt/tools'

// Same tool definitions and annotations as /chatgpt/mcp, minus the OpenAI-only _meta keys.
// shortcut: keeps ui.resourceUri (the MCP Apps widget); drop it if Claude clients stop rendering it.
const claudeTool = (t: (typeof TOOL_LIST)[number]) => ({
  ...t,
  _meta: Object.fromEntries(Object.entries(t._meta).filter(([k]) => !k.startsWith('openai/') && k !== 'securitySchemes')),
})

export default createSurface({ channel: 'claude', toolList: TOOL_LIST.map(claudeTool), inlineData: true, sessions: true })
