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
  it('rejects non true/false booleans', () => {
    expect(parse('b=yes')).toHaveProperty('error')
    expect(parse('b=')).toHaveProperty('error')
  })
  it('rejects a repeated scalar', () => {
    expect(parse('n=1&n=2')).toHaveProperty('error')
  })
})
