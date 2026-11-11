import { describe, it, expect } from 'vitest'
import { apyDisplay, insuranceDisplay, presentRow } from '../chatgpt/present'

// Cases are real production rows (APY is stored as a fraction: 0.033 = 3.3%).
describe('apyDisplay', () => {
  it.each([
    ['Ramp: max equals default, unconditional', 0.02, 0.02, '2% APY'],
    ['Grasshopper: balance-tiered', 0.0135, 0.01, 'Up to 1.35% APY (conditions apply)'],
    ['Bluevine: plan/activity condition', 0.033, 0.013, 'Up to 3.3% APY (conditions apply)'],
    ['Found: free plan pays 0, paid plan pays more', 0.025, 0, 'Up to 2.5% APY (conditions apply)'],
    ['default unknown', 0.0132, null, 'Up to 1.32% APY'],
  ])('%s', (_n, max, dflt, want) => expect(apyDisplay(max, dflt)).toBe(want))

  it.each([[null, null], [0, 0], [undefined, 0.01], ['0.03', 0.03]])('says nothing for max=%s (not offered or not published)', (max, dflt) =>
    expect(apyDisplay(max, dflt)).toBeUndefined())
})

// insurance_type is NOT NULL (fdic|ncua|uninsured). Active listings today: 9 extended ($3M-$125M), 4 plain FDIC.
describe('insuranceDisplay', () => {
  it.each([
    ['plain FDIC', 'fdic', false, null, 'FDIC insured'],
    ['FDIC, extended unknown', 'fdic', null, null, 'FDIC insured'],
    ['extended with limit', 'fdic', true, 3000000, 'Extended FDIC coverage up to $3M'],
    ['extended, large limit', 'fdic', true, 125000000, 'Extended FDIC coverage up to $125M'],
    ['extended, limit unpublished', 'fdic', true, null, 'Extended FDIC coverage'],
    ['NCUA', 'ncua', false, null, 'NCUA insured'],
    ['uninsured', 'uninsured', false, null, 'Uninsured'],
    ['missing value falls to Uninsured', null, false, null, 'Uninsured'],
    ['undefined falls to Uninsured', undefined, undefined, undefined, 'Uninsured'],
  ])('%s', (_n, type, ext, lim, want) => expect(insuranceDisplay(type, ext, lim)).toBe(want))
})

describe('presentRow', () => {
  it('formats dollars so a $0 fee can never read as 0%, and keeps raw values', () => {
    const r = presentRow({ monthly_fee: 0, minimum_opening_deposit: 0, apy_max: null })
    expect(r.monthly_fee_display).toBe('$0/month')
    expect(r.minimum_opening_deposit_display).toBe('$0 to open')
    expect(r.apy_display).toBeUndefined()
    expect(r.monthly_fee).toBe(0)
  })
  it('formats cents and thousands', () => {
    const r = presentRow({ monthly_fee: 14.5, minimum_opening_deposit: 1500 })
    expect(r.monthly_fee_display).toBe('$14.5/month')
    expect(r.minimum_opening_deposit_display).toBe('$1,500 to open')
  })
  it('omits fee/deposit/APY strings for unpublished values instead of inventing them', () => {
    const r = presentRow({ product_name: 'X' })
    expect(Object.keys(r).sort()).toEqual(['insurance_display', 'product_name'])
  })
})
