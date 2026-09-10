import { Decimal } from 'decimal.js'

export const decimalCeilNumber = (num: number | string, decimal: number) =>
  new Decimal(num).toDecimalPlaces(decimal, Decimal.ROUND_CEIL).toNumber()

export const decimalFloorNumber = (num: number | string, decimal: number) =>
  new Decimal(num).toDecimalPlaces(decimal, Decimal.ROUND_FLOOR).toNumber()

export const decimalRoundNumber = (num: number | string, decimal: number) =>
  new Decimal(num).toDecimalPlaces(decimal, Decimal.ROUND_HALF_UP).toNumber()

// Shift the decimal point via string exponent notation (exact, no `x * 1e5`
// binary error), apply the integer rounding, then shift back. Falls back to the
// Decimal-based variant when the value is too extreme for a finite fast result.
const fast =
  (round: (n: number) => number, precise: (num: number | string, decimal: number) => number) =>
  (num: number | string, decimal: number) => {
    if (decimal >= 6) {
      return precise(num, decimal)
    }
    const result = Number(`${round(Number(`${num}e${decimal}`))}e${-decimal}`)
    if (Number.isFinite(result)) {
      return result
    } else {
      return precise(num, decimal)
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
