import { describe, it, expect } from 'vitest'
import { applyApplicationUrlHost, tagApplicationUrl } from '../lib/urls'

const QR = '11111111-2222-4333-8444-555555555555'

describe('tagApplicationUrl', () => {
  it('appends src and qr to an untagged URL', () => {
    expect(tagApplicationUrl('https://bancadia.com/go/a/b', { src: 'mcp', qr: QR })).toBe(
      `https://bancadia.com/go/a/b?src=mcp&qr=${QR}`
    )
  })

  it('merges with an existing query string and never overwrites existing params', () => {
    expect(tagApplicationUrl('https://bancadia.com/go/a/b?src=llms_txt&x=1', { src: 'mcp', qr: QR })).toBe(
      `https://bancadia.com/go/a/b?src=llms_txt&x=1&qr=${QR}`
    )
  })

  it('preserves a fragment', () => {
    expect(tagApplicationUrl('https://bancadia.com/go/a/b#top', { src: 'mcp' })).toBe(
      'https://bancadia.com/go/a/b?src=mcp#top'
    )
  })

  it('skips null/undefined/empty tag values (e.g. no request id)', () => {
    expect(tagApplicationUrl('https://bancadia.com/go/a/b', { src: 'mcp', qr: undefined })).toBe(
      'https://bancadia.com/go/a/b?src=mcp'
    )
    expect(tagApplicationUrl('https://bancadia.com/go/a/b', { qr: '' })).toBe('https://bancadia.com/go/a/b')
  })

  it('returns a non-absolute value unchanged', () => {
    expect(tagApplicationUrl('/go/a/b', { src: 'mcp' })).toBe('/go/a/b')
  })
})

describe('applyApplicationUrlHost', () => {
  it('host-prefixes then tags, leaving null and rows without application_url untouched', () => {
    const out = applyApplicationUrlHost(
      [{ application_url: '/go/a/b' }, { application_url: null }, { other: 1 }],
      { src: 'mcp', qr: QR }
    )
    expect(out).toEqual([
      { application_url: `https://bancadia.com/go/a/b?src=mcp&qr=${QR}` },
      { application_url: null },
      { other: 1 },
    ])
  })

  it('still only host-prefixes when called without tags', () => {
    expect(applyApplicationUrlHost([{ application_url: '/go/a/b' }])).toEqual([
      { application_url: 'https://bancadia.com/go/a/b' },
    ])
  })
})
