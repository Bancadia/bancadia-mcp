// Pre-formatted display strings added next to the raw v2 values. Raw fields keep their v2 units
// (monthly_fee in dollars, apy_* as fractions: 0.033 = 3.3%), which models and the widget misread
// without a unit, so both are told to quote the *_display strings instead.
type Row = Record<string, unknown>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const usd = (n: number) => `$${Number(n.toFixed(2)).toLocaleString('en-US')}`
const pct = (frac: number) => `${Number((frac * 100).toFixed(2))}%`

const compactUsd = (n: number) => (n >= 1e6 ? `$${Number((n / 1e6).toFixed(1))}M` : usd(n))

// Always one of: extended coverage (with limit when published), "FDIC insured", "NCUA insured" or
// "Uninsured". insurance_type is NOT NULL (fdic|ncua|uninsured), so a missing value is not a real
// bank state; it falls to "Uninsured" per product decision rather than hiding the line.
export function insuranceDisplay(type: unknown, extended: unknown, extendedLimit: unknown): string {
  if (extended === true) {
    const lim = num(extendedLimit)
    return lim ? `Extended FDIC coverage up to ${compactUsd(lim)}` : 'Extended FDIC coverage'
  }
  const t = typeof type === 'string' ? type.toLowerCase() : ''
  return t === 'fdic' ? 'FDIC insured' : t === 'ncua' ? 'NCUA insured' : 'Uninsured'
}

export function apyDisplay(max: unknown, dflt: unknown): string | undefined {
  const m = num(max)
  if (!m || m <= 0) return undefined // 0/absent: not offered or not published, so say nothing
  const d = num(dflt)
  if (d === m) return `${pct(m)} APY`
  // max above the default means a condition (balance tier, plan, activity) unlocks it; the detail
  // is in apy_tiers/plan_tiers, not on the tile.
  return d === null ? `Up to ${pct(m)} APY` : `Up to ${pct(m)} APY (conditions apply)`
}

export function presentRow(r: Row): Row {
  const fee = num(r.monthly_fee)
  const dep = num(r.minimum_opening_deposit)
  const apy = apyDisplay(r.apy_max, r.apy_default)
  return {
    ...r,
    ...(fee !== null ? { monthly_fee_display: `${usd(fee)}/month` } : {}),
    ...(dep !== null ? { minimum_opening_deposit_display: `${usd(dep)} minimum deposit to open` } : {}),
    ...(apy ? { apy_display: apy } : {}),
    insurance_display: insuranceDisplay(r.insurance_type, r.deposit_insurance_extended, r.deposit_insurance_extended_limit),
  }
}
