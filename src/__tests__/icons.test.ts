import { describe, it, expect } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'
import app from '../index'

describe('site icons', () => {
  it.each([
    ['/favicon.ico', 'image/x-icon', [0x00, 0x00, 0x01, 0x00]],
    ['/icon.png', 'image/png', [0x89, 0x50, 0x4e, 0x47]],
  ])('%s is served publicly as a real image', async (path, type, magic) => {
    const res = await app.fetch(new Request(`http://localhost${path}`), env, createExecutionContext())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe(type)
    expect([...new Uint8Array(await res.arrayBuffer()).slice(0, 4)]).toEqual(magic)
  })
})
