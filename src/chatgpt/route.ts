import { createSurface } from '../lib/surface'
import { TOOL_LIST } from './tools'

// ChatGPT App: stateless, structuredContent carries the data (see lib/surface).
export default createSurface({ channel: 'chatgpt', toolList: TOOL_LIST, inlineData: false, sessions: false })
