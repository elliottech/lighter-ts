import type { EventOrderBookEntry, FeeTiers, Layer1BasicInfo, SystemConfig } from 'zklighter-perps'
import type { StateCreator } from 'zustand'

import { defaultL1Info, defaultSystemConfig } from '../../fallbacks/defaults'
import type { BackendFeeTiers } from '../../types/user-tiers'

import type {
  WsAssetStats,
  WsBOMarketStats,
  WsOrderbook,
  WsPerpsMarketStats,
  WsSpotMarketStats,
} from '../../lighter-ws/types/WsMessage'
import type { UpDownPriceCandle } from '../../ws-sub-store/upDownPrice'
import type {
  AssetMeta,
  PerpsOrderBookDetail,
  SpotOrderBookDetail,
} from '../../types/compatibility'
import type { Trade } from '../types'

import type { ExtendedCandlestick } from './types'

export interface OrderBookSlice {
  systemConfig: SystemConfig
  feeTiers: FeeTiers | null
  fallbackFeeTiers: BackendFeeTiers | null
  l1Info: Layer1BasicInfo
  perpsOrderBookMetas: Record<string, PerpsOrderBookDetail>
  spotOrderBookMetas: Record<string, SpotOrderBookDetail>
  orderBookMetasLoaded: boolean
  assetMetasLoaded: boolean
  assetMetas: Record<string, AssetMeta>
  perpsMarketsStats: Record<string, WsPerpsMarketStats>
  spotMarketsStats: Record<string, WsSpotMarketStats>
  boMarketsStats: Record<string, WsBOMarketStats>
  upDownCandles: Record<string, UpDownPriceCandle[]>
  assetsStats: Record<string, WsAssetStats>
  l1AssetBalances: Record<string, number>
  currentMarketId: number
  currentBOMarket: EventOrderBookEntry | undefined
  trades: Trade[] | null
  // Live candlesticks bucketed by `${marketId}/${obResolution}` (see getCandleKey).
  newCandlesticksByKey: Record<string, ExtendedCandlestick[]>
  liquidationTrades: Trade[] | null
  orderBook: WsOrderbook | null
  // The socket closed since this book's snapshot. It stays on screen but must
  // not price an order until the resubscribe snapshot replaces it.
  orderBookStale: boolean
  height: number | null
}

export const createOrderBookSlice: StateCreator<OrderBookSlice, [], [], OrderBookSlice> = () => ({
  systemConfig: defaultSystemConfig,
  feeTiers: null,
  fallbackFeeTiers: null,
  l1Info: defaultL1Info,
  perpsOrderBookMetas: {},
  spotOrderBookMetas: {},
  orderBookMetasLoaded: false,
  assetMetasLoaded: false,
  assetMetas: {},
  perpsMarketsStats: {},
  spotMarketsStats: {},
  boMarketsStats: {},
  upDownCandles: {},
  assetsStats: {},
  l1AssetBalances: {},
  currentMarketId: -1,
  currentBOMarket: undefined,
  trades: null,
  newCandlesticksByKey: {},
  liquidationTrades: null,
  orderBook: null,
  orderBookStale: false,
  height: null,
})
