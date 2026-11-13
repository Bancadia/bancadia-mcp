import { describe, it, expect } from 'vitest'
import { WIDGET_HTML } from '../chatgpt/widget'

// The widget is one HTML string with no browser here, so these pin the loading behavior's contract. Rendering was checked in Chrome with a postMessage harness.
describe('widget loading state', () => {
  const script = WIDGET_HTML.split('<script>')[1]!.split('</script>')[0]!

  it('inline script is valid JavaScript', () => {
    expect(() => new Function(script)).not.toThrow()
  })

  it('starts as three skeleton cards, busy, with motion off for reduced-motion users', () => {
    expect(WIDGET_HTML.match(/class="sk"/g)).toHaveLength(3)
    expect(WIDGET_HTML).toContain('aria-busy="true"')
    expect(WIDGET_HTML).toMatch(/prefers-reduced-motion:reduce\)\{\.sk i\{animation:none\}/)
  })

  it('leaves the skeleton on a result, error, cancel, set_globals or after 25 seconds', () => {
    expect(script).toContain('},25000)')
    expect(script).toContain("m.params.isError")
    expect(script).toContain('ui/notifications/tool-cancelled')
    expect(script).toContain('openai:set_globals')
  })

  it('renders identical data once', () => {
    expect(script).toMatch(/if\(key===lastKey\)return/)
  })
})
