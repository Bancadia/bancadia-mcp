import { describe, it, expect } from 'vitest'
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import app from '../index'

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const request = new Request('http://localhost/health')
    const ctx = createExecutionContext()
    const response = await app.fetch(request, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ status: 'ok' })
  })
})

describe('GET /.well-known/openai-apps-challenge', () => {
  it('returns the challenge token as plain text', async () => {
    const ctx = createExecutionContext()
    const response = await app.fetch(
      new Request('http://localhost/.well-known/openai-apps-challenge'),
      env,
      ctx,
    )
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toBe('DBkimlGN4cK9KTi9FyNmbqd1EmM1QaP5OMK0UbVg5Dc')
  })
})
