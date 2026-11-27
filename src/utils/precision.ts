import { Decimal } from 'decimal.js'

// `Decimal#toDecimalPlaces` throws `[DecimalError] Invalid argument` on a
// non-integer `decimal`. Market/asset decimals are server-driven, so a corrupt
// value (e.g. `display_size_decimals: 4.9`) would crash every caller. Truncate
// it to the intended precision (0 for non-finite input). Nullish keeps the
// previous behavior: `toDecimalPlaces` returned the value unrounded.
const toSafeDecimals = (decimal: number) => {
  if (decimal == null || Number.isInteger(decimal)) return decimal
  const n = Number(decimal)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

export const decimalCeilNumber = (num: number | string, decimal: number) =>
  new Decimal(num).toDecimalPlaces(toSafeDecimals(decimal), Decimal.ROUND_CEIL).toNumber()

export const decimalFloorNumber = (num: number | string, decimal: number) =>
  new Decimal(num).toDecimalPlaces(toSafeDecimals(decimal), Decimal.ROUND_FLOOR).toNumber()

export const decimalRoundNumber = (num: number | string, decimal: number) =>
  new Decimal(num).toDecimalPlaces(toSafeDecimals(decimal), Decimal.ROUND_HALF_UP).toNumber()

// Shift the decimal point via string exponent notation (exact, no `x * 1e5`
// binary error), apply the integer rounding, then shift back. Falls back to the
// Decimal-based variant when the value is too extreme for a finite fast result.
const fast =
  (round: (n: number) => number, precise: (num: number | string, decimal: number) => number) =>
  (num: number | string, decimal: number) => {
    const decimals = toSafeDecimals(decimal)
    if (decimals >= 6) {
      return precise(num, decimals)
    }
    const result = Number(`${round(Number(`${num}e${decimals}`))}e${-decimals}`)
    if (Number.isFinite(result)) {
      return result
    } else {
      return precise(num, decimals)
    }
  }

export const ceilNumber = fast(Math.ceil, decimalCeilNumber)
export const floorNumber = fast(Math.floor, decimalFloorNumber)
// Rounding is done on absolute value to fix this case
// -10 = new Decimal(-9.5).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
//  10 = new Decimal( 9.5).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber()
//  -9 = Math.round(-9.5)
//  10 = Math.round( 9.5)
export const roundNumber = fast((n) => Math.sign(n) * Math.round(Math.abs(n)), decimalRoundNumber)

// `0.0014 * 100 / 100` is `0.0013999999999999998` in floats, which floors a
// full-size order one step short.
export const floorPercentOf = (amount: number, percentage: number, decimal: number) =>
  Number.isFinite(amount * percentage)
    ? decimalFloorNumber(new Decimal(amount).mul(percentage).div(100).toString(), decimal)
    : floorNumber((amount * percentage) / 100, decimal)
