import { describe, expect, it } from 'vitest'
import { AccountPositionSignEnum } from 'zklighter-perps'

import { FREE_ORDER_BATCH_SIZE } from '../constants/shared'
import type { Position } from '../store/types'
import { computeCloseAllPositionPrice, computeCloseAllPositionsPriceWarnings } from './common'

describe('computeCloseAllPositionPrice', () => {
  it('prices a long close at the best bid minus the max slippage', () => {
    expect(computeCloseAllPositionPrice(true, 1, 100, 100)).toEqual({
      price: 99,
      isFarFromMarkPrice: false,
      isMarkPriceMissing: false,
    })
  })

  it('prices a short close at the best ask plus the max slippage', () => {
    expect(computeCloseAllPositionPrice(false, 1, 100, 100)?.price).toBe(101)
  })

  it('flags a long close whose price is more than 5% under the mark price', () => {
    const result = computeCloseAllPositionPrice(true, 1, 60, 100)
    expect(result?.price).toBeCloseTo(59.4)
    expect(result?.isFarFromMarkPrice).toBe(true)
  })

  it('flags a short close whose price is more than 5% over the mark price', () => {
    expect(computeCloseAllPositionPrice(false, 1, 140, 100)?.isFarFromMarkPrice).toBe(true)
  })

  it('flags a close whose own slippage reaches past 5% of the mark price', () => {
    expect(computeCloseAllPositionPrice(true, 10, 100, 100)?.isFarFromMarkPrice).toBe(true)
  })

  it('flags a close that has a book price but no mark price', () => {
    expect(computeCloseAllPositionPrice(true, 1, 100, null)).toEqual({
      price: 99,
      isFarFromMarkPrice: false,
      isMarkPriceMissing: true,
    })
    expect(computeCloseAllPositionPrice(true, 1, 100, 0)?.isMarkPriceMissing).toBe(true)
  })

  it('falls back to the mark price when there is no book price', () => {
    expect(computeCloseAllPositionPrice(true, 1, undefined, 100)).toEqual({
      price: 99,
      isFarFromMarkPrice: false,
      isMarkPriceMissing: false,
    })
  })

  it('returns null when there is neither a book nor a mark price', () => {
    expect(computeCloseAllPositionPrice(true, 1, undefined, null)).toBeNull()
    expect(computeCloseAllPositionPrice(true, 1, 0, 0)).toBeNull()
  })
})

describe('computeCloseAllPositionsPriceWarnings', () => {
  const positionsFor = (count: number): Record<string, Position> =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index): [string, Position] => [
        String(index + 1),
        {
          market_id: index + 1,
          position: 1,
          sign: AccountPositionSignEnum.Long,
        } as Position,
      ]),
    )

  const marketsFor = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [index + 1, { symbol: `M${index + 1}` }]),
    ) as Parameters<typeof computeCloseAllPositionsPriceWarnings>[0]['markets']

  it('only warns for standard-tier positions that will be sent', () => {
    const count = FREE_ORDER_BATCH_SIZE + 1
    const closePrices = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [index + 1, index + 1 === count ? 60 : 100]),
    )
    const markPrices = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [index + 1, 100]),
    )

    expect(
      computeCloseAllPositionsPriceWarnings({
        positions: positionsFor(count),
        isStandardTier: true,
        maxSlippage: 1,
        closePrices,
        markPrices,
        markets: marketsFor(count),
      }),
    ).toEqual({ farFromMarkSymbols: '', markPriceMissingSymbols: '' })
  })

  it('includes warnings for sent positions, including all premium positions', () => {
    const count = FREE_ORDER_BATCH_SIZE + 1
    const positions = positionsFor(count)
    const closePrices = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [index + 1, index + 1 === count ? 60 : 100]),
    )
    const markPrices = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [index + 1, 100]),
    )
    delete markPrices[4]

    expect(
      computeCloseAllPositionsPriceWarnings({
        positions,
        isStandardTier: true,
        maxSlippage: 1,
        closePrices: { ...closePrices, 3: 60 },
        markPrices,
        markets: marketsFor(count),
      }),
    ).toEqual({
      farFromMarkSymbols: 'M3',
      markPriceMissingSymbols: 'M4',
    })

    expect(
      computeCloseAllPositionsPriceWarnings({
        positions,
        isStandardTier: false,
        maxSlippage: 1,
        closePrices,
        markPrices,
        markets: marketsFor(count),
      }),
    ).toEqual({
      farFromMarkSymbols: 'M41',
      markPriceMissingSymbols: 'M4',
    })
  })
})
