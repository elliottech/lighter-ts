import { describe, expect, it } from 'vitest'

import { AccountPositionMarginModeEnum } from 'zklighter-perps'

import {
  selectActiveOrdersSpotIndexPrices,
  selectMaxLeverageMarketUpdates,
  selectTWAPOrderPrice,
} from './common'

const getUpdates = selectMaxLeverageMarketUpdates.resultFunc
type SelectorInputs = Parameters<typeof getUpdates>

const rawPositions = {} as SelectorInputs[0]
const activeOrders = { 1: [{}] } as unknown as SelectorInputs[2]
const markets = {
  1: {
    market_id: 1,
    symbol: 'ETH',
    market_flags: 0,
    default_initial_margin_fraction: 1_000,
    min_initial_margin_fraction: 500,
  },
} as unknown as SelectorInputs[4]

describe('selectMaxLeverageMarketUpdates', () => {
  it.each([
    ['positions', true, false, true],
    ['active orders', false, true, true],
    ['market metadata', false, false, false],
  ])(
    'returns no updates while %s are loading',
    (_source, positionsLoading, activeOrdersLoading, orderBookMetasLoaded) => {
      expect(
        getUpdates(
          rawPositions,
          positionsLoading,
          activeOrders,
          activeOrdersLoading,
          markets,
          orderBookMetasLoaded,
        ),
      ).toEqual([])
    },
  )

  it('returns order-only markets after every source is hydrated', () => {
    expect(getUpdates(rawPositions, false, activeOrders, false, markets, true)).toEqual([
      {
        market: markets[1],
        from: 10,
        to: 20,
        marginMode: AccountPositionMarginModeEnum.Cross,
        initialMarginFraction: 500,
      },
    ])
  })
})

const getPrices = selectActiveOrdersSpotIndexPrices.resultFunc
type PriceInputs = Parameters<typeof getPrices>

const spotMarkets = {
  2048: { market_id: 2048, base_asset_id: 1 },
  2049: { market_id: 2049, base_asset_id: 2 },
  2050: { market_id: 2050, base_asset_id: 3 },
} as unknown as PriceInputs[1]
const assetsStats = {
  1: { index_price: 2_500 },
  2: { index_price: 0.5 },
} as unknown as PriceInputs[2]

describe('selectActiveOrdersSpotIndexPrices', () => {
  it('maps spot markets with active orders to their base asset index price', () => {
    const activeOrders = { 0: [{}], 2048: [{}], 2049: [] } as unknown as PriceInputs[0]

    expect(getPrices(activeOrders, spotMarkets, assetsStats)).toEqual({ 2048: 2_500 })
  })

  it('skips markets whose base asset has no stats yet', () => {
    const activeOrders = { 2048: [{}], 2050: [{}] } as unknown as PriceInputs[0]

    expect(getPrices(activeOrders, spotMarkets, assetsStats)).toEqual({ 2048: 2_500 })
  })
})

describe('selectTWAPOrderPrice', () => {
  it('bounds a perps TWAP sell at half the mark price and buy at twice the mark price', () => {
    expect(selectTWAPOrderPrice.resultFunc(true, false, 100, 50)).toBe(50)
    expect(selectTWAPOrderPrice.resultFunc(false, false, 100, 50)).toBe(200)
    expect(selectTWAPOrderPrice.resultFunc(false, false, 100, null)).toBe(200)
    expect(selectTWAPOrderPrice.resultFunc(false, false, null, 50)).toBe(0)
    expect(selectTWAPOrderPrice.resultFunc(true, false, null, 50)).toBe(0)
  })

  it('bounds a spot TWAP sell to 10% below the index price', () => {
    expect(selectTWAPOrderPrice.resultFunc(true, true, null, 50)).toBeCloseTo(45)
  })

  it('bounds a spot TWAP buy to 10% above the index price', () => {
    expect(selectTWAPOrderPrice.resultFunc(false, true, null, 50)).toBeCloseTo(55)
  })

  it('gives a spot TWAP no price while the index price is missing', () => {
    expect(selectTWAPOrderPrice.resultFunc(true, true, null, null)).toBe(0)
    expect(selectTWAPOrderPrice.resultFunc(false, true, null, null)).toBe(0)
    expect(selectTWAPOrderPrice.resultFunc(false, true, null, 0)).toBe(0)
  })
})
