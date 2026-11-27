import { ORDER_PRICE_GUARD_PCT } from '../presets'
import { OrderPriceGuardError } from './errors'
import type { IsAsk, MarketDataSource, MarketMeta } from './types'

/** Deterministic, seedable PRNG (mulberry32). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Buffer applied to the min-quote slice floor so a small adverse price move
 * between planning and submission doesn't drop a slice's notional below the
 * venue minimum (which rejects with "invalid order base or quote amount").
 */
const MIN_QUOTE_BUFFER = 1.05

/**
 * Minimum slice size in human base units for this market. Combines the
 * venue's `min_base_amount` (e.g. "2.00" LIT) with, when a reference price is
 * known, enough base that the slice notional clears `min_quote_amount`
 * (e.g. $10) with a small buffer. Never below one integer base unit.
 */
export function getMinSliceSize(market: MarketMeta, referencePrice?: number | null): number {
  let minSize = Number(market.min_base_amount)
  if (referencePrice) {
    minSize = Math.max(
      minSize,
      (Number(market.min_quote_amount) * MIN_QUOTE_BUFFER) / referencePrice,
    )
  }
  return Math.max(10 ** -market.size_decimals, minSize)
}

/** The worst price a child order may take: `percent` above the index for
 *  buys, below it for sells. */
export function getIndexBoundPrice(indexPrice: number, percent: number, isAsk: IsAsk): number {
  const distance = percent / 100

  return isAsk === 1 ? indexPrice * (1 - distance) : indexPrice * (1 + distance)
}

export function capAtBound(price: number, bound: number, isAsk: IsAsk): number {
  return isAsk === 1 ? Math.max(price, bound) : Math.min(price, bound)
}

export function assertOrderPriceNearIndex(
  marketData: MarketDataSource,
  marketId: number,
  price: number,
  isAsk: IsAsk,
): void {
  const market = marketData.getMarket(marketId)
  const indexPrice = marketData.getIndexPrice(marketId)
  const referencePrice = indexPrice || marketData.getMarkPrice(marketId)

  if (!market || !referencePrice) {
    throw new OrderPriceGuardError('No index price to check the order price against')
  }

  const orderPrice = price / 10 ** market.price_decimals
  const bound = getIndexBoundPrice(referencePrice, ORDER_PRICE_GUARD_PCT, isAsk)

  if (capAtBound(orderPrice, bound, isAsk) !== orderPrice) {
    throw new OrderPriceGuardError(
      `Order price ${orderPrice} is more than ${ORDER_PRICE_GUARD_PCT}% ${isAsk === 1 ? 'below' : 'above'} the ${indexPrice ? 'index' : 'mark'} price ${referencePrice}`,
    )
  }
}
