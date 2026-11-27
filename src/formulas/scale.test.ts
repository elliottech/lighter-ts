import { describe, expect, it } from 'vitest'

import { convertFloatToBase } from '../utils/common'
import {
  computeLimitOrdersInBase,
  computeScaleOrderPrices,
  computeSizeDistribution,
  pickScaleStartEndOrders,
} from './scale'

const ladder = (startPrice: number, endPrice: number, isShort: boolean) =>
  [
    { price: startPrice, size: 0.02 * 0.4 },
    { price: (startPrice + endPrice) / 2, size: 0.02 * 0.33 },
    { price: endPrice, size: 0.02 * 0.27 },
  ].sort((a, b) => (isShort ? a.price - b.price : b.price - a.price))

describe('pickScaleStartEndOrders', () => {
  it.each([
    ['buy, start below end', 2000, 2100, false],
    ['buy, start above end', 2100, 2000, false],
    ['sell, start below end', 2000, 2100, true],
    ['sell, start above end', 2100, 2000, true],
  ])('labels the start and end prices for a %s', (_, startPrice, endPrice, isShort) => {
    const { startOrder, endOrder } = pickScaleStartEndOrders(
      ladder(startPrice, endPrice, isShort),
      startPrice,
    )
    expect(startOrder?.price).toBe(startPrice)
    expect(endOrder?.price).toBe(endPrice)
    expect(startOrder?.size).toBeCloseTo(0.02 * 0.4)
    expect(endOrder?.size).toBeCloseTo(0.02 * 0.27)
  })

  it('returns nothing for fewer than two orders', () => {
    expect(pickScaleStartEndOrders([{ price: 2000 }], 2000)).toEqual({
      startOrder: null,
      endOrder: null,
    })
  })
})

describe('computeScaleOrderPrices', () => {
  it('rounds ascending and descending middle legs to the nearest tick', () => {
    expect(computeScaleOrderPrices(100, 105, 4, 2)).toEqual([10000, 10167, 10333, 10500])
    expect(computeScaleOrderPrices(105, 100, 4, 2)).toEqual([10500, 10333, 10167, 10000])
  })

  it('rounds a half tick up', () => {
    expect(computeScaleOrderPrices(100, 100.01, 3, 2)).toEqual([10000, 10001, 10001])
  })

  it('keeps the end ticks equal to the converted endpoint prices', () => {
    const prices = computeScaleOrderPrices(0.3, 0.7, 5, 1)

    expect(prices[0]).toBe(convertFloatToBase(0.3, 1))
    expect(prices.at(-1)).toBe(convertFloatToBase(0.7, 1))
  })
})

describe('computeLimitOrdersInBase', () => {
  it('allocates integer leg sizes that sum to the total base amount', () => {
    const orders = computeLimitOrdersInBase(
      500.28,
      computeScaleOrderPrices(100, 105, 3, 2),
      computeSizeDistribution(3, 0.1),
      false,
      { price_decimals: 2, size_decimals: 2 },
    )

    expect(orders).toEqual([
      { price: 10500, baseAmount: 3032 },
      { price: 10250, baseAmount: 16676 },
      { price: 10000, baseAmount: 30320 },
    ])
    expect(orders.reduce((sum, order) => sum + order.baseAmount, 0)).toBe(50028)
  })

  it('allocates the remainder to legs 1 through r', () => {
    expect(
      computeLimitOrdersInBase(7, [10, 11, 12, 13, 14], computeSizeDistribution(5, 1), false, {
        price_decimals: 0,
        size_decimals: 0,
      }),
    ).toEqual([
      { price: 14, baseAmount: 1 },
      { price: 13, baseAmount: 2 },
      { price: 12, baseAmount: 2 },
      { price: 11, baseAmount: 1 },
      { price: 10, baseAmount: 1 },
    ])
  })
})
