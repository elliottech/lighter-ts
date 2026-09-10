import type { OrderBookDetail } from '../types/compatibility'
import { convertFloatToBase } from '../utils/common'

export const computePriceDistribution = (
  startPrice: number,
  endPrice: number,
  orderCount: number,
) => {
  if (startPrice === 0 || endPrice === 0 || orderCount < 2) {
    return []
  }

  const priceSpan = endPrice - startPrice
  const priceStep = priceSpan / (orderCount - 1)

  return Array.from({ length: orderCount }, (_, index) => startPrice + priceStep * index)
}

export const computeSizeDistribution = (orderCount: number, skew: number) => {
  if (skew < 0.01 || skew > 100 || orderCount < 2) {
    return []
  }

  const startSize = 2 / (orderCount * (1 + skew))
  const endSize = startSize * skew
  const sizeSpan = endSize - startSize
  const sizeStep = sizeSpan / (orderCount - 1)

  return Array.from({ length: orderCount }, (_, index) => startSize + sizeStep * index)
}

export const computeLimitOrders = (
  baseAmount: number,
  priceDistribution: number[],
  sizeDistribution: number[],
  isShort: boolean,
) => {
  return Array.from({ length: priceDistribution.length }, (_, index) => ({
    price: priceDistribution[index]!,
    size: baseAmount * sizeDistribution[index]!,
  })).sort((a, b) => (isShort ? a.price - b.price : b.price - a.price))
}

// 7 divided in 5 orders -> [2, 2, 1, 1, 1]
export const computeLimitOrdersInBase = (
  orders: { price: number; size: number }[],
  baseAmount: number,
  currentMarket: Pick<OrderBookDetail, 'price_decimals' | 'size_decimals'>,
) => {
  const expectedSum = convertFloatToBase(baseAmount, currentMarket.size_decimals)
  const baseSum = orders.reduce(
    (acc, { size }) => acc + convertFloatToBase(size, currentMarket.size_decimals),
    0,
  )
  const remainder = expectedSum - baseSum

  return orders.map(({ size, price }, index) => ({
    baseAmount:
      convertFloatToBase(size, currentMarket.size_decimals) +
      (index !== 0 && index <= remainder ? 1 : 0),
    price: convertFloatToBase(price, currentMarket.price_decimals),
  }))
}

// weighted average
export const computeAverageLimitPrice = (
  priceDistribution: number[],
  sizeDistribution: number[],
) => {
  if (priceDistribution.length < 2 || sizeDistribution.length < 2) {
    return 0
  }

  let totalSize = 0
  let sum = 0

  priceDistribution.forEach((price, index) => {
    const weight = sizeDistribution[index]!
    totalSize += weight
    sum += price * weight
  })

  return sum / totalSize
}
