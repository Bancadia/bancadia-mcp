import { describe, it, expect, vi } from 'vitest'
import { widgetHtml } from '../chatgpt/widget'

const WIDGET_HTML = widgetHtml('chatgpt')

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

// Runs the widget script against a minimal DOM stub and clicks Learn More, so the message each host
// receives is checked, not just the source text.
function runWidget(host: 'chatgpt' | 'claude', openai?: object) {
  const script = widgetHtml(host).split('<script>')[1]!.split('</script>')[0]!
  type El = { tag: string; kids: El[]; textContent: string; className: string; handlers: Record<string, () => void>; [k: string]: unknown }
  const mk = (tag: string): El => ({
    tag, kids: [], textContent: '', className: '', handlers: {}, disabled: false,
    appendChild(c: El) { this.kids.push(c); return c }, setAttribute() {},
    addEventListener(t: string, f: () => void) { this.handlers[t] = f },
  })
  const byId: Record<string, El> = Object.fromEntries(['head', 'root', 'foot', 'note'].map((i) => [i, mk('div')]))
  const sent: Array<{ id?: number; method: string; params: Record<string, unknown> }> = []
  const listeners: Record<string, (e: unknown) => void> = {}
  const parent = { postMessage: (m: (typeof sent)[number]) => void sent.push(m) }
  const win = { openai, addEventListener: (t: string, f: (e: unknown) => void) => void (listeners[t] = f) }
  new Function('window', 'document', 'parent', 'setTimeout', script)(
    win,
    { getElementById: (i: string) => byId[i], createElement: mk, body: { getBoundingClientRect: () => ({ height: 100 }) } },
    parent,
    () => 0
  )
  const deliver = (m: object) => listeners.message!({ source: parent, data: { jsonrpc: '2.0', ...m } })
  deliver({ method: 'ui/notifications/tool-result', params: { structuredContent: { total_matches: 1, rows: [{ listing_slug: 'a-bank', institution_name: 'A Bank', product_name: 'Checking' }] } } })
  const button = byId.root!.kids[0]!.kids.find((k) => k.tag === 'button')!
  button.handlers.click!()
  return { sent, deliver, note: byId.note! }
}

describe('Learn More per host', () => {
  const TEXT = 'Tell me more about A Bank Checking (a-bank) and why it could fit my business.'

  it('claude sends ui/message with an array of text blocks', () => {
    const { sent } = runWidget('claude')
    const msg = sent.find((m) => m.method === 'ui/message')!
    expect(msg.params).toEqual({ role: 'user', content: [{ type: 'text', text: TEXT }] })
  })

  it('claude shows the outcome: accepted, declined, or unconfirmed', async () => {
    for (const [reply, shown] of [
      [{ result: {} }, /Sent to Claude/],
      [{ result: { isError: true } }, /didn't take the request/],
      [{ error: { code: -32000, message: 'denied' } }, /Couldn't confirm/],
    ] as const) {
      const { sent, deliver, note } = runWidget('claude')
      deliver({ id: sent.find((m) => m.method === 'ui/message')!.id, ...reply })
      await new Promise((r) => setTimeout(r, 0))
      expect(note.textContent).toMatch(shown)
    }
  })

  it('chatgpt calls sendFollowUpMessage and never sends ui/message', async () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue(undefined)
    const { sent } = runWidget('chatgpt', { sendFollowUpMessage })
    await new Promise((r) => setTimeout(r, 0))
    expect(sendFollowUpMessage).toHaveBeenCalledWith({ prompt: TEXT })
    expect(sent.some((m) => m.method === 'ui/message')).toBe(false)
  })
})
