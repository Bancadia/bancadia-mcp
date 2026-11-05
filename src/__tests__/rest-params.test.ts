import { describe, it, expect } from 'vitest'
import { parseQueryParams } from '../rest/params'

const schema = {
  properties: {
    n: { type: 'number' },
    b: { type: 'boolean' },
    a: { type: 'array' },
    s: { type: 'string' },
  },
}
const parse = (q: string) => parseQueryParams(new URLSearchParams(q), schema)

describe('parseQueryParams', () => {
  it('parses each type', () => {
    expect(parse('n=0&b=true&s=x')).toEqual({ args: { n: 0, b: true, s: 'x' } })
    expect(parse('b=false')).toEqual({ args: { b: false } })
  })
  it('splits comma arrays and merges repeats', () => {
    expect(parse('a=llc,s_corp')).toEqual({ args: { a: ['llc', 's_corp'] } })
    expect(parse('a=x&a=y,z')).toEqual({ args: { a: ['x', 'y', 'z'] } })
    expect(parse('a=')).toEqual({ args: { a: [] } })
  })
  it('returns no args for an empty query', () => {
    expect(parse('')).toEqual({ args: {} })
  })
  it('rejects unknown keys', () => {
    expect(parse('nope=1')).toHaveProperty('error')
  })
  it('rejects NaN, Infinity and empty numbers', () => {
    expect(parse('n=abc')).toHaveProperty('error')
    expect(parse('n=Infinity')).toHaveProperty('error')
    expect(parse('n=')).toHaveProperty('error')
  })
  it('rejects non-decimal numbers', () => {
    for (const v of ['0x10', '%205%20', '1e999', '1e3', '+5', '.5', '5.', '--1']) {
      expect(parse(`n=${v}`), v).toHaveProperty('error')
    }
  })
  it('accepts plain decimals', () => {
    expect(parse('n=-1.5')).toEqual({ args: { n: -1.5 } })
    expect(parse('n=25')).toEqual({ args: { n: 25 } })
  })
  it('caps array items at 50', () => {
    const items = (k: number) => Array.from({ length: k }, (_, i) => `v${i}`).join(',')
    expect(parse(`a=${items(50)}`)).toHaveProperty('args')
    expect(parse(`a=${items(51)}`)).toHaveProperty('error')
  })
  it('caps a single value at 200 chars', () => {
    expect(parse(`s=${'x'.repeat(200)}`)).toHaveProperty('args')
    expect(parse(`s=${'x'.repeat(201)}`)).toHaveProperty('error')
    expect(parse(`a=${'x'.repeat(201)}`)).toHaveProperty('error')
  })
  it('rejects non true/false booleans', () => {
    expect(parse('b=yes')).toHaveProperty('error')
    expect(parse('b=')).toHaveProperty('error')
  })
  it('rejects a repeated scalar', () => {
    expect(parse('n=1&n=2')).toHaveProperty('error')
  })
})
