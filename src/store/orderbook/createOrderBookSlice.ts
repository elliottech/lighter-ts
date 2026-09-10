import { keyBy } from 'lodash-es'
import type { Layer1BasicInfo, SystemConfig, Token as ApiToken } from 'zklighter-perps'
import type { StateCreator } from 'zustand'

import {
  assetMetasFallback,
  l1InfoFallback,
  orderBookMetasFallback,
  systemConfigFallback,
  tokensFallback,
} from '../../fallbacks'
import type {
  WsAssetStats,
  WsOrderbook,
  WsPerpsMarketStats,
  WsSpotMarketStats,
} from '../../lighter-ws/types/WsMessage'
import type {
  AssetMeta,
  PerpsOrderBookDetail,
  SpotOrderBookDetail,
} from '../../types/compatibility'
import { normalizeTokens } from '../../utils/normalizeTokens'
import { withDisplaySymbol } from '../../utils/withDisplaySymbol'
import type { Trade } from '../types'

import type { ExtendedCandlestick } from './types'

export interface OrderBookSlice {
  systemConfig: SystemConfig
  l1Info: Layer1BasicInfo
  perpsOrderBookMetas: Record<string, PerpsOrderBookDetail>
  spotOrderBookMetas: Record<string, SpotOrderBookDetail>
  orderBookMetasLoaded: boolean
  assetMetasLoaded: boolean
  assetMetas: Record<string, AssetMeta>
  perpsMarketsStats: Record<string, WsPerpsMarketStats>
  spotMarketsStats: Record<string, WsSpotMarketStats>
  assetsStats: Record<string, WsAssetStats>
  l1AssetBalances: Record<string, number>
  currentMarketId: number
  trades: Trade[] | null
  // Live candlesticks bucketed by `${marketId}/${obResolution}` (see getCandleKey).
  newCandlesticksByKey: Record<string, ExtendedCandlestick[]>
  liquidationTrades: Trade[] | null
  orderBook: WsOrderbook | null
  height: number | null
}

const fallbackDisplaySymbols = Object.fromEntries(
  normalizeTokens(tokensFallback.tokens as ApiToken[]).map((token) => [
    token.backend_symbol,
    token.symbol,
  ]),
)

export const createOrderBookSlice: StateCreator<OrderBookSlice, [], [], OrderBookSlice> = () => ({
  systemConfig: systemConfigFallback,
  l1Info: l1InfoFallback,
  perpsOrderBookMetas: keyBy(
    (
      orderBookMetasFallback.order_book_details as Omit<PerpsOrderBookDetail, 'backend_symbol'>[]
    ).map((detail) => withDisplaySymbol(detail, fallbackDisplaySymbols)),
    'market_id',
  ),
  spotOrderBookMetas: keyBy(
    (
      orderBookMetasFallback.spot_order_book_details as Omit<
        SpotOrderBookDetail,
        'backend_symbol'
      >[]
    ).map((detail) => withDisplaySymbol(detail, fallbackDisplaySymbols)),
    'market_id',
  ),
  orderBookMetasLoaded: false,
  assetMetasLoaded: false,
  assetMetas: keyBy(
    (assetMetasFallback.asset_details as Omit<AssetMeta, 'backend_symbol'>[]).map((detail) =>
      withDisplaySymbol(detail, fallbackDisplaySymbols),
    ),
    'asset_id',
  ),
  perpsMarketsStats: {},
  spotMarketsStats: {},
  assetsStats: {},
  l1AssetBalances: {},
  currentMarketId: -1,
  trades: null,
  newCandlesticksByKey: {},
  liquidationTrades: null,
  orderBook: null,
  height: null,
})
