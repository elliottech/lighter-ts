import type { OrderBookSlice } from '../store/orderbook/createOrderBookSlice'
import { getMarketDisplayPrice } from './getMarketDisplayPrice'

export const selectMarketDisplayPrice = (
  {
    perpsMarketsStats,
    spotMarketsStats,
  }: Pick<OrderBookSlice, 'perpsMarketsStats' | 'spotMarketsStats'>,
  marketId: number,
) => getMarketDisplayPrice(perpsMarketsStats[marketId] ?? spotMarketsStats[marketId])
