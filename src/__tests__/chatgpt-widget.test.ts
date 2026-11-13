import { describe, it, expect } from 'vitest'
import { WIDGET_HTML } from '../chatgpt/widget'

// The widget is one HTML string with no browser here, so these pin its message handling. Rendering was checked in Chrome with a postMessage harness.
describe('widget result handling', () => {
  const script = WIDGET_HTML.split('<script>')[1]!.split('</script>')[0]!

  it('inline script is valid JavaScript', () => {
    expect(() => new Function(script)).not.toThrow()
  })

  it('has no loading skeleton: ChatGPT creates the frame only when the result exists', () => {
    expect(WIDGET_HTML).not.toMatch(/class="sk"|aria-busy/)
  })

  it('shows a message on an error result or a cancel instead of "No matching accounts"', () => {
    expect(script).toContain('m.params.isError')
    expect(script).toContain('ui/notifications/tool-cancelled')
    expect(script).toMatch(/function fail\(msg\)\{if\(lastKey\)return/) // never replaces cards already shown
  })

  it('renders identical data once and picks up a late toolOutput', () => {
    expect(script).toMatch(/if\(key===lastKey\)return/)
    expect(script).toContain('openai:set_globals')
  })
})
