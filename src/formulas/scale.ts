import type { OrderBookDetail } from '../types/compatibility'
import { convertFloatToBase } from '../utils/common'

export const computeScaleOrderPrices = (
  startPrice: number,
  endPrice: number,
  orderCount: number,
  priceDecimals: number,
) => {
  if (startPrice === 0 || endPrice === 0 || orderCount < 2) {
    return []
  }

  const startTick = convertFloatToBase(startPrice, priceDecimals)
  const tickSpan = convertFloatToBase(endPrice, priceDecimals) - startTick

  return Array.from(
    { length: orderCount },
    (_, index) =>
      startTick + Math.floor((2 * tickSpan * index + (orderCount - 1)) / (2 * (orderCount - 1))),
  )
}

export const computeSizeDistribution = (orderCount: number, skew: number) => {
  if (skew < 0.01 || skew > 100 || orderCount < 2) {
    return []
  }

  const skewPercent = Math.round(skew * 100)

  return Array.from(
    { length: orderCount },
    (_, index) => 100 * (orderCount - 1) + (skewPercent - 100) * index,
  )
}

export const pickScaleStartEndOrders = <T extends { price: number }>(
  orders: T[],
  startPrice: number,
) => {
  if (orders.length < 2) return { startOrder: null, endOrder: null }
  const first = orders[0]!
  const last = orders[orders.length - 1]!
  const firstIsStart = Math.abs(first.price - startPrice) <= Math.abs(last.price - startPrice)
  return firstIsStart
    ? { startOrder: first, endOrder: last }
    : { startOrder: last, endOrder: first }
}

// 7 divided in 5 orders -> [2, 2, 1, 1, 1]
export const computeLimitOrdersInBase = (
  baseAmount: number,
  prices: number[],
  sizeDistribution: number[],
  isShort: boolean,
  currentMarket: Pick<OrderBookDetail, 'price_decimals' | 'size_decimals'>,
) => {
  const totalBase = convertFloatToBase(baseAmount, currentMarket.size_decimals)
  const totalWeight = sizeDistribution.reduce((acc, weight) => acc + weight, 0)
  const orders = prices
    .map((price, index) => ({
      price,
      baseAmount: Math.floor((totalBase * sizeDistribution[index]!) / totalWeight),
    }))
    .sort((a, b) => (isShort ? a.price - b.price : b.price - a.price))
  const remainder = totalBase - orders.reduce((acc, order) => acc + order.baseAmount, 0)

  return orders.map((order, index) => ({
    ...order,
    baseAmount: order.baseAmount + (index !== 0 && index <= remainder ? 1 : 0),
  }))
}

// weighted average
export const computeAverageLimitPrice = (prices: number[], sizeDistribution: number[]) => {
  if (prices.length < 2 || sizeDistribution.length < 2) {
    return 0
  }

  let totalSize = 0
  let sum = 0

  prices.forEach((price, index) => {
    const weight = sizeDistribution[index]!
    totalSize += weight
    sum += price * weight
  })

  return sum / totalSize
}
