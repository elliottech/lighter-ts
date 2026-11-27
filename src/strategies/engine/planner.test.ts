import { describe, expect, it } from 'vitest'

import { capAtBound, createRng, getIndexBoundPrice, getMinSliceSize } from './planner'
import type { MarketMeta } from './types'

// --- helpers ----------------------------------------------------------------

const makeMarket = (overrides: Partial<MarketMeta> = {}): MarketMeta => ({
  market_id: 1,
  size_decimals: 5,
  price_decimals: 2,
  min_base_amount: '0',
  min_quote_amount: '0',
  multiplier: '1',
  display_price_decimals: overrides.price_decimals ?? 2,
  ...overrides,
})

// --- createRng --------------------------------------------------------------

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = Array.from({ length: 8 }, () => a())
    const seqB = Array.from({ length: 8 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('produces values in [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 200; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('different seeds produce different sequences', () => {
    const a = createRng(1)
    const b = createRng(2)
    const seqA = Array.from({ length: 8 }, () => a())
    const seqB = Array.from({ length: 8 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })
})

describe('getMinSliceSize', () => {
  it('returns the human min_base_amount', () => {
    expect(getMinSliceSize(makeMarket({ size_decimals: 2, min_base_amount: '2.00' }))).toBe(2)
  })

  it('floors at the min-quote notional (with buffer) when a price is known', () => {
    // 10 * 1.05 / 1.41 ≈ 7.4468
    expect(
      getMinSliceSize(
        makeMarket({
          size_decimals: 2,
          min_base_amount: '2.00',
          min_quote_amount: '10.000000',
        }),
        1.41,
      ),
    ).toBeCloseTo(7.4468, 4)
  })

  it('ignores the quote floor without a reference price', () => {
    expect(
      getMinSliceSize(
        makeMarket({
          size_decimals: 2,
          min_base_amount: '2.00',
          min_quote_amount: '10.000000',
        }),
        null,
      ),
    ).toBe(2)
  })

  it('never returns below one base unit', () => {
    expect(getMinSliceSize(makeMarket({ size_decimals: 2 }))).toBe(0.01)
  })
})

// --- index band ---------------------------------------------------------------

describe('getIndexBoundPrice', () => {
  it('is above the index for buys and below it for sells', () => {
    expect(getIndexBoundPrice(2400, 3, 0)).toBeCloseTo(2472)
    expect(getIndexBoundPrice(2400, 3, 1)).toBeCloseTo(2328)
  })

  it('is the index itself at 0%', () => {
    expect(getIndexBoundPrice(2400, 0, 0)).toBe(2400)
    expect(getIndexBoundPrice(2400, 0, 1)).toBe(2400)
  })
})

describe('capAtBound', () => {
  it('caps buys from above and leaves cheaper prices alone', () => {
    expect(capAtBound(20_000, 2472, 0)).toBe(2472)
    expect(capAtBound(2410, 2472, 0)).toBe(2410)
  })

  it('floors sells from below and leaves richer prices alone', () => {
    expect(capAtBound(1, 2328, 1)).toBe(2328)
    expect(capAtBound(2390, 2328, 1)).toBe(2390)
  })
})
