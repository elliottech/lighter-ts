import { groupBy, mapValues, pickBy } from 'lodash-es'

import { computeSpotMarketTvl } from '../../formulas/computeSpotMarketTvl'
import type {
  WsOrderbook,
  WsOrderbookItem,
  WsPerpsMarketStats,
  WsSpotMarketStats,
} from '../../lighter-ws/types/WsMessage'
import type {
  OrderBookDetail,
  PerpsOrderBookDetail,
  SpotOrderBookDetail,
} from '../../types/compatibility'
import { getCandleKey } from '../../utils/candlesticks'
import { convertBaseToFloat, convertFloatToBase, isMarketSpot } from '../../utils/common'
import { displayPriceToReal, realPriceToDisplay, realSizeToDisplay } from '../../utils/multiplier'
import {
  buildSyntheticPerpsEntry,
  buildSyntheticSpotEntry,
} from '../../utils/synthetic-market-details'
import { selectAssetId, selectMarketId } from '../params/selectors'
import { selectMarketTradesFilterBy, selectOrderBookGroupBy } from '../preferences/selectors'
import {
  selectAllowedAssetSymbols,
  selectAllowedTokenSymbols,
  selectDefaultOrderBookGroupBySymbol,
  selectRwaCoins,
  selectTokens,
  selectTokenSymbols,
  selectUrlEnabledAssetIds,
  selectUrlEnabledMarketIds,
} from '../tokens/selectors'
import type { Order } from '../types'
import { createDeepEqualSelector } from '../utils/createDeepEqualSelector'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import type { OrderBookSlice } from './createOrderBookSlice'

export const LLP_ASSET_ID = 42
export const LIT_ASSET_ID = 2
export const USDC_ASSET_ID = 3
const LIT_MARKET_ID = 120

const DEFAULT_ORDER_BOOK: WsOrderbook = { asks: [], bids: [] }

const MAX_OI_LIMIT = 72057594037927936 // 2^56

export const selectSystemConfig = (state: OrderBookSlice) => state.systemConfig

// 0 means fee collection is off: no integrator approval, no attributes on orders
export const selectFeeCollectorAccountIndex = (state: OrderBookSlice) =>
  state.systemConfig.fee_collector_account_index ?? 0

export const selectL1Info = (state: OrderBookSlice) => state.l1Info

export const selectBlockHeight = (state: OrderBookSlice) => state.height

const selectOrderBookTrades = (state: OrderBookSlice) => state.trades

export const selectNewCandlesticks = (
  state: OrderBookSlice,
  params: { marketId: number; resolution: string },
) => state.newCandlesticksByKey[getCandleKey(params.marketId, params.resolution)] ?? null

const selectOrderBookLiquidationTrades = (state: OrderBookSlice) => state.liquidationTrades

export const selectOrderBook = (state: OrderBookSlice) => state.orderBook ?? DEFAULT_ORDER_BOOK

export const selectOrderBookLoading = (state: OrderBookSlice) => !state.orderBook

const selectRawSpotOrderBookMetas = (state: OrderBookSlice) => state.spotOrderBookMetas

const selectRawPerpsOrderBookMetas = (state: OrderBookSlice) => state.perpsOrderBookMetas

export const selectUpcomingSymbols = createSelector(
  [selectTokens],
  createTracking(
    'selectUpcomingSymbols',
    (tokens) =>
      new Set(
        (tokens ?? [])
          .filter((t) => t.is_allowed_mainnet && t.categories.includes('UPCOMING'))
          .map((t) => t.backend_symbol),
      ),
  ),
)

const selectSyntheticPerpsOrderBookMetas = createSelector(
  [selectTokens],
  createTracking('selectSyntheticPerpsOrderBookMetas', (tokens) => {
    if (!tokens) return {}
    return tokens.reduce<Record<string, PerpsOrderBookDetail>>((acc, t, i) => {
      if (t.market === 'PERPS' && t.is_allowed_mainnet && t.categories.includes('UPCOMING')) {
        const id = -(i + 2)
        acc[id] = buildSyntheticPerpsEntry(t.symbol, id, t.backend_symbol)
      }
      return acc
    }, {})
  }),
)

const selectSyntheticSpotOrderBookMetas = createSelector(
  [selectTokens],
  createTracking('selectSyntheticSpotOrderBookMetas', (tokens) => {
    if (!tokens) return {}
    return tokens.reduce<Record<string, SpotOrderBookDetail>>((acc, t, i) => {
      if (t.market === 'SPOT' && t.is_allowed_mainnet && t.categories.includes('UPCOMING')) {
        const id = -(i + 2)
        acc[id] = buildSyntheticSpotEntry(t.symbol, id, t.backend_symbol)
      }
      return acc
    }, {})
  }),
)

export const selectSyntheticOrderBookMetas = createSelector(
  [selectSyntheticSpotOrderBookMetas, selectSyntheticPerpsOrderBookMetas],
  createTracking('selectSyntheticOrderBookMetas', (spot, perps) => ({ ...spot, ...perps })),
)

const isAllowedMeta = (
  meta: OrderBookDetail,
  id: string,
  tokenSymbols: Set<string>,
  allowedTokenSymbols: Set<string>,
  urlEnabledMarketIds: Set<number>,
  upcomingSymbols: Set<string>,
) => {
  if (upcomingSymbols.has(meta.backend_symbol)) return false
  if (!tokenSymbols.has(meta.backend_symbol)) return true
  return allowedTokenSymbols.has(meta.backend_symbol) || urlEnabledMarketIds.has(Number(id))
}

const selectSpotOrderBookMetas = createSelector(
  [
    selectRawSpotOrderBookMetas,
    selectSyntheticSpotOrderBookMetas,
    selectTokenSymbols,
    selectAllowedTokenSymbols,
    selectUrlEnabledMarketIds,
    selectUpcomingSymbols,
  ],
  createTracking(
    'selectSpotOrderBookMetas',
    (
      metas,
      synthetics,
      tokenSymbols,
      allowedTokenSymbols,
      urlEnabledMarketIds,
      upcomingSymbols,
    ) => ({
      ...pickBy(metas, (meta, id) =>
        isAllowedMeta(
          meta,
          id,
          tokenSymbols,
          allowedTokenSymbols,
          urlEnabledMarketIds,
          upcomingSymbols,
        ),
      ),
      ...synthetics,
    }),
  ),
)

export const selectPerpsOrderBookMetas = createSelector(
  [
    selectRawPerpsOrderBookMetas,
    selectSyntheticPerpsOrderBookMetas,
    selectTokenSymbols,
    selectAllowedTokenSymbols,
    selectUrlEnabledMarketIds,
    selectUpcomingSymbols,
  ],
  createTracking(
    'selectPerpsOrderBookMetas',
    (
      metas,
      synthetics,
      tokenSymbols,
      allowedTokenSymbols,
      urlEnabledMarketIds,
      upcomingSymbols,
    ) => ({
      ...pickBy(metas, (meta, id) =>
        isAllowedMeta(
          meta,
          id,
          tokenSymbols,
          allowedTokenSymbols,
          urlEnabledMarketIds,
          upcomingSymbols,
        ),
      ),
      ...synthetics,
    }),
  ),
)

export const selectOrderBookMetasLoaded = (state: OrderBookSlice) => state.orderBookMetasLoaded
export const selectAssetMetasLoaded = (state: OrderBookSlice) => state.assetMetasLoaded

export const selectPerpsMarketsStats = (state: OrderBookSlice) => state.perpsMarketsStats
export const selectPerpsMarketsStatsLoading = (state: OrderBookSlice) =>
  Object.keys(state.perpsMarketsStats).length === 0

export const selectSpotMarketsStats = (state: OrderBookSlice) => state.spotMarketsStats

const selectAssetsStats = (state: OrderBookSlice) => state.assetsStats

const selectL1AssetBalances = (state: OrderBookSlice) => state.l1AssetBalances

export const selectCurrentMarketId = (state: OrderBookSlice) => state.currentMarketId

const selectRawAssetMetas = (state: OrderBookSlice) => state.assetMetas

export const selectAssetMetas = createSelector(
  [selectRawAssetMetas, selectTokenSymbols, selectAllowedAssetSymbols, selectUrlEnabledAssetIds],
  createTracking(
    'selectAssetMetas',
    (metas, assetSymbols, allowedAssetSymbols, urlEnabledAssetIds) =>
      pickBy(
        metas,
        (meta) =>
          !assetSymbols.has(meta.backend_symbol) ||
          allowedAssetSymbols.has(meta.backend_symbol) ||
          urlEnabledAssetIds.has(meta.asset_id),
      ),
  ),
)

export const selectAssetMeta = createSelector(
  [selectAssetMetas, selectAssetId],
  createTracking('selectAssetMeta', (assetMetas, assetId) => assetMetas[assetId]!),
)

export const selectUsdcSymbol = createSelector(
  [selectAssetMetas],
  createTracking('selectUsdcSymbol', (assetMetas) => assetMetas[USDC_ASSET_ID]?.symbol ?? 'USDC'),
)

export const selectOrderBookMetas = createSelector(
  [selectSpotOrderBookMetas, selectPerpsOrderBookMetas],
  createTracking('selectOrderBookMetas', (spotOrderBookMetas, perpsOrderBookMetas) => ({
    ...spotOrderBookMetas,
    ...perpsOrderBookMetas,
  })),
)

export const selectNonSyntheticOrderBookMetas = createSelector(
  [selectOrderBookMetas],
  createTracking('selectNonSyntheticOrderBookMetas', (orderBookMetas) =>
    Object.fromEntries(Object.entries(orderBookMetas).filter(([, meta]) => meta.market_id >= 0)),
  ),
)

export const selectSpotOrderBookMetasByBaseAssetId = createSelector(
  [selectSpotOrderBookMetas],
  createTracking('selectSpotOrderBookMetasByBaseAssetId', (spotOrderBookMetas) =>
    Object.values(spotOrderBookMetas).reduce<Record<string, SpotOrderBookDetail>>((acc, market) => {
      if (market.quote_asset_id === USDC_ASSET_ID) {
        acc[market.base_asset_id] = market
      }

      return acc
    }, {}),
  ),
)

export const selectActiveOrderBookMetas = createSelector(
  [selectOrderBookMetas],
  createTracking('selectActiveOrderBookMetas', (orderBookMetas) =>
    Object.fromEntries(
      Object.entries(orderBookMetas).filter(([, detail]) => detail.status === 'active'),
    ),
  ),
)

export const selectAssetStats = createSelector(
  [selectAssetsStats, selectAssetId],
  createTracking('selectAssetStats', (assetsStats, assetId) => assetsStats[assetId]),
)

export const selectAssetIndexPrices = createDeepEqualSelector(
  [selectAssetsStats],
  createTracking('selectAssetIndexPrices', (assetsStats) =>
    mapValues(assetsStats, (assetStats) => assetStats.index_price),
  ),
)

const selectSpotMarketsTvl = createDeepEqualSelector(
  [selectSpotOrderBookMetas, selectAssetsStats, selectL1AssetBalances],
  createTracking('selectSpotMarketsTvl', (spotOrderBookMetas, assetsStats, l1AssetBalances) =>
    mapValues(spotOrderBookMetas, (meta) =>
      computeSpotMarketTvl(
        assetsStats[meta.base_asset_id]?.index_price,
        l1AssetBalances[meta.base_asset_id],
      ),
    ),
  ),
)

export const selectSpotMarketTvl = createSelector(
  [selectSpotMarketsTvl, selectMarketId],
  createTracking(
    'selectSpotMarketTvl',
    (spotMarketsTvl, marketId) => spotMarketsTvl[marketId] ?? null,
  ),
)

export const selectAssetIndexPrice = createSelector(
  [selectAssetIndexPrices, selectAssetId],
  createTracking('selectAssetIndexPrice', (assetIndexPrices, assetId) => assetIndexPrices[assetId]),
)

export const selectOrderBookMeta = createSelector(
  [selectOrderBookMetas, selectMarketId],
  createTracking('selectOrderBookMeta', (orderBookMetas, marketId) => orderBookMetas[marketId]!),
)

export const selectPerpsOrderBookMeta = createSelector(
  [selectPerpsOrderBookMetas, selectMarketId],
  createTracking(
    'selectPerpsOrderBookMeta',
    (perpsOrderBookMetas, marketId) => perpsOrderBookMetas[marketId],
  ),
)

export const selectCurrentMarket = createSelector(
  [selectOrderBookMetas, selectCurrentMarketId],
  createTracking(
    'selectCurrentMarket',
    (orderBookMetas, currentMarketId) => orderBookMetas[currentMarketId]!,
  ),
)

export const selectIsUpcomingMarket = createSelector(
  [selectUpcomingSymbols, selectCurrentMarket],
  createTracking(
    'selectIsUpcomingMarket',
    (upcomingSymbols, market) => !!market && upcomingSymbols.has(market.backend_symbol),
  ),
)

export const selectCurrentPerpsMarket = createSelector(
  [selectPerpsOrderBookMetas, selectCurrentMarketId],
  createTracking(
    'selectCurrentPerpsMarket',
    (perpsOrderBookMetas, currentMarketId) => perpsOrderBookMetas[currentMarketId],
  ),
)

export const isHiddenMarket = (market: SpotOrderBookDetail | PerpsOrderBookDetail) => {
  if (isMarketSpot(market)) {
    return false
  }

  return market.market_config.hidden
}

export const selectIsMarketSpot = createSelector(
  [selectOrderBookMeta],
  createTracking('selectIsMarketSpot', isMarketSpot),
)

export const selectIsCurrentMarketSpot = createSelector(
  [selectCurrentMarket],
  createTracking('selectIsCurrentMarketSpot', isMarketSpot),
)

const selectParamCurrentMarketOrderBookMultiplier = <
  ParamsT extends { currentMarketOrderBookMultiplier?: number },
>(
  _state: unknown,
  params?: ParamsT,
) => params?.currentMarketOrderBookMultiplier

const selectCurrentMarketDefaultOrderBookGroupBy = createSelector(
  [selectCurrentMarket, selectDefaultOrderBookGroupBySymbol],
  createTracking(
    'selectCurrentMarketDefaultOrderBookGroupBy',
    (currentMarket, defaultOrderBookGroupBySymbol) =>
      defaultOrderBookGroupBySymbol[currentMarket?.backend_symbol] ?? 1,
  ),
)

export const selectCurrentMarketOrderBookMultiplier = createSelector(
  [
    selectOrderBookGroupBy,
    selectCurrentMarketId,
    selectParamCurrentMarketOrderBookMultiplier,
    selectCurrentMarketDefaultOrderBookGroupBy,
  ],
  createTracking(
    'selectCurrentMarketOrderBookMultiplier',
    (
      orderBookGroupBy,
      currentMarketId,
      currentMarketOrderBookMultiplier,
      defaultOrderBookGroupBy,
    ) =>
      currentMarketOrderBookMultiplier ??
      orderBookGroupBy[currentMarketId] ??
      defaultOrderBookGroupBy,
  ),
)

export const selectCurrentMarketTrimmedPriceDecimals = createSelector(
  [selectCurrentMarketOrderBookMultiplier],
  createTracking('selectCurrentMarketTrimmedPriceDecimals', (selectedMultiplier) => {
    let decimals = 0
    let multiplier = selectedMultiplier
    while (multiplier % 10 === 0 && multiplier !== 0) {
      multiplier /= 10
      decimals += 1
    }
    return decimals
  }),
)

export const selectCurrentMarketMarketTradesFilterBy = createSelector(
  [selectMarketTradesFilterBy, selectCurrentMarketId],
  createTracking(
    'selectCurrentMarketMarketTradesFilterBy',
    (marketTradesFilterBy, currentMarketId) => marketTradesFilterBy[currentMarketId] ?? 0,
  ),
)

export interface DisplayOrderbookItem extends WsOrderbookItem {
  userOrderSize: number
  userOrderPrice: number
  quote: number
  totalBase: number
  totalQuote: number
  totalPercentageBase: number
  totalPercentageQuote: number
  progressBase: number
  progressQuote: number
  displayPrice?: number
}
const emptyDisplayOrderbookItem: DisplayOrderbookItem = {
  price: 0,
  size: 0,
  userOrderSize: 0,
  userOrderPrice: 0,
  quote: 0,
  totalBase: 0,
  totalQuote: 0,
  totalPercentageBase: 0,
  totalPercentageQuote: 0,
  progressBase: 0,
  progressQuote: 0,
}

export const computeDisplayOrderBook = (
  orderBook: WsOrderbook,
  currentMarket: Pick<OrderBookDetail, 'price_decimals' | 'multiplier' | 'display_price_decimals'>,
  priceGrouping: number,
  userActiveOrders: Order[] | undefined | null,
  count: number,
  paramPercentageRange?: number,
) => {
  const userActiveOrdersByPrice = groupBy(userActiveOrders ?? [], (order) => {
    const basePrice = convertFloatToBase(
      realPriceToDisplay(order.price, currentMarket),
      currentMarket.display_price_decimals,
    )
    const floatingPrice = basePrice / priceGrouping

    return order.is_ask
      ? Math.max(priceGrouping, Math.ceil(floatingPrice) * priceGrouping)
      : Math.max(priceGrouping, Math.floor(floatingPrice) * priceGrouping)
  })
  const asks = Array.from<DisplayOrderbookItem>({ length: count })
  let currentAskIndex = -1
  const lastAskPrice =
    paramPercentageRange && orderBook.asks[0]?.price
      ? orderBook.asks[0].price * (1 + paramPercentageRange)
      : null
  for (const currentAsk of orderBook.asks) {
    if (lastAskPrice) {
      if (currentAsk.price > lastAskPrice) {
        break
      }
    }
    const basePrice = convertFloatToBase(
      realPriceToDisplay(currentAsk.price, currentMarket),
      currentMarket.display_price_decimals,
    )
    const currentAskDisplayPrice = Math.max(
      priceGrouping,
      Math.ceil(basePrice / priceGrouping) * priceGrouping,
    )
    const realAskPrice = convertFloatToBase(
      displayPriceToReal(
        convertBaseToFloat(currentAskDisplayPrice, currentMarket.display_price_decimals),
        currentMarket,
        true,
      ),
      currentMarket.price_decimals,
    )

    if (currentAskIndex === -1 || asks[currentAskIndex]!.displayPrice !== currentAskDisplayPrice) {
      currentAskIndex++
      if (currentAskIndex >= count) break
      asks[currentAskIndex] = {
        ...emptyDisplayOrderbookItem,
        price: realAskPrice,
        displayPrice: currentAskDisplayPrice,
        size: currentAsk.size,
        quote: currentAsk.size * currentAsk.price,
      }
    } else {
      asks[currentAskIndex]!.size += currentAsk.size
      asks[currentAskIndex]!.quote += currentAsk.size * currentAsk.price
    }
  }
  // in case orderbook is empty we want to have length 0 and not count
  asks.length = Math.min(currentAskIndex + 1, orderBook.asks.length, count)

  const bids = Array.from<DisplayOrderbookItem>({ length: count })
  let currentBidIndex = -1
  const lastBidPrice =
    paramPercentageRange && orderBook.bids[0]?.price
      ? orderBook.bids[0].price * (1 - paramPercentageRange)
      : null
  for (const currentBid of orderBook.bids) {
    if (lastBidPrice) {
      if (currentBid.price < lastBidPrice) {
        break
      }
    }
    const basePrice = convertFloatToBase(
      realPriceToDisplay(currentBid.price, currentMarket),
      currentMarket.display_price_decimals,
    )
    const currentBidDisplayPrice = Math.max(
      priceGrouping,
      Math.floor(basePrice / priceGrouping) * priceGrouping,
    )

    const realBidPrice = convertFloatToBase(
      displayPriceToReal(
        convertBaseToFloat(currentBidDisplayPrice, currentMarket.display_price_decimals),
        currentMarket,
        false,
      ),
      currentMarket.price_decimals,
    )
    if (currentBidIndex === -1 || bids[currentBidIndex]!.displayPrice !== currentBidDisplayPrice) {
      currentBidIndex++
      if (currentBidIndex >= count) break
      bids[currentBidIndex] = {
        ...emptyDisplayOrderbookItem,
        price: realBidPrice,
        displayPrice: currentBidDisplayPrice,
        size: currentBid.size,
        quote: currentBid.size * currentBid.price,
      }
    } else {
      bids[currentBidIndex]!.size += currentBid.size
      bids[currentBidIndex]!.quote += currentBid.size * currentBid.price
    }
  }
  // in case orderbook is empty we want to have length 0 and not count
  bids.length = Math.min(currentBidIndex + 1, orderBook.bids.length, count)

  const groupedMaxTotalSizeBase = Math.max(
    asks.reduce((acc, ask) => acc + ask.size, 0),
    bids.reduce((acc, bid) => acc + bid.size, 0),
  )
  const groupedMaxTotalSizeQuote = Math.max(
    asks.reduce((acc, ask) => acc + ask.quote, 0),
    bids.reduce((acc, bid) => acc + bid.quote, 0),
  )

  let asksTotalBase = 0
  let asksTotalQuote = 0
  for (let i = 0; i < asks.length; i++) {
    const currentSize = asks[i]!.size
    const currentPrice = convertBaseToFloat(asks[i]!.price, currentMarket.price_decimals)
    const userOrders = userActiveOrdersByPrice[asks[i]!.displayPrice!]

    asksTotalBase += currentSize
    asksTotalQuote += asks[i]!.quote

    asks[i] = {
      price: currentPrice,
      size: asks[i]!.size,
      userOrderSize: userOrders?.reduce((acc, order) => acc + order.remaining_base_amount, 0) ?? 0,
      userOrderPrice:
        userOrders?.reduce((acc, order) => acc + order.remaining_base_amount * order.price, 0) ?? 0,
      quote: asks[i]!.quote,
      totalBase: asksTotalBase,
      totalQuote: asksTotalQuote,
      totalPercentageBase: (asksTotalBase / groupedMaxTotalSizeBase) * 100,
      totalPercentageQuote: (asksTotalQuote / groupedMaxTotalSizeQuote) * 100,
      progressBase: (currentSize / asksTotalBase) * 100,
      progressQuote: (asks[i]!.quote / asksTotalQuote) * 100,
    }
  }

  let bidsTotalBase = 0
  let bidsTotalQuote = 0
  for (let i = 0; i < bids.length; i++) {
    const currentSize = bids[i]!.size
    const currentPrice = convertBaseToFloat(bids[i]!.price, currentMarket.price_decimals)
    const userOrders = userActiveOrdersByPrice[bids[i]!.displayPrice!]

    bidsTotalBase += currentSize
    bidsTotalQuote += bids[i]!.quote
    bids[i] = {
      price: currentPrice,
      size: currentSize,
      userOrderSize: userOrders?.reduce((acc, order) => acc + order.remaining_base_amount, 0) ?? 0,
      userOrderPrice:
        userOrders?.reduce((acc, order) => acc + order.remaining_base_amount * order.price, 0) ?? 0,
      quote: bids[i]!.quote,
      totalBase: bidsTotalBase,
      totalQuote: bidsTotalQuote,
      totalPercentageBase: (bidsTotalBase / groupedMaxTotalSizeBase) * 100,
      totalPercentageQuote: (bidsTotalQuote / groupedMaxTotalSizeQuote) * 100,
      progressBase: (currentSize / bidsTotalBase) * 100,
      progressQuote: (bids[i]!.quote / bidsTotalQuote) * 100,
    }
  }
  return {
    asks,
    bids,
  }
}

export const selectDisplayMarketTrades = createSelector(
  [selectOrderBookTrades, selectCurrentMarket, selectCurrentMarketMarketTradesFilterBy],
  createTracking('selectDisplayMarketTrades', (trades, currentMarket, filterBy) =>
    trades?.filter(
      (trade) =>
        convertFloatToBase(
          realSizeToDisplay(trade.size, currentMarket),
          currentMarket.display_size_decimals,
        ) > filterBy,
    ),
  ),
)

export const selectDisplayLiquidationTrades = createSelector(
  [selectOrderBookLiquidationTrades, selectCurrentMarket, selectCurrentMarketMarketTradesFilterBy],
  createTracking('selectDisplayLiquidationTrades', (liquidationTrades, currentMarket, filterBy) =>
    liquidationTrades?.filter(
      (trade) =>
        convertFloatToBase(
          realSizeToDisplay(trade.size, currentMarket),
          currentMarket.display_size_decimals,
        ) > filterBy,
    ),
  ),
)

export const selectMidPrice = createSelector(
  [selectOrderBook],
  createTracking('selectMidPrice', ({ asks, bids }) => {
    if (!asks.length && !bids.length) {
      return 0
    }

    if (!asks.length) {
      return bids[0]!.price
    }

    if (!bids.length) {
      return asks[0]!.price
    }

    return (asks[0]!.price + bids[0]!.price) / 2
  }),
)

export const selectBestPrices = createSelector(
  [selectOrderBook],
  createTracking('selectBestPrices', ({ asks, bids }) => ({
    bestAskPrice: asks[0]?.price ?? 0,
    bestBidPrice: bids[0]?.price ?? 0,
  })),
)

export const selectSpread = createSelector(
  [selectBestPrices],
  createTracking('selectSpread', ({ bestAskPrice, bestBidPrice }) => {
    if (!bestAskPrice || !bestBidPrice) {
      return 0
    }

    return Math.max(0, bestAskPrice - bestBidPrice)
  }),
)

export const selectSpreadPercentage = createSelector(
  [selectSpread, selectBestPrices],
  createTracking('selectSpreadPercentage', (spread, bestPrices) =>
    spread === 0 || bestPrices.bestAskPrice === 0 ? 0 : (spread / bestPrices.bestAskPrice) * 100,
  ),
)

export const selectPerpsMarketStats = createSelector(
  [selectPerpsMarketsStats, selectMarketId],
  createTracking(
    'selectPerpsMarketStats',
    (perpsMarketsStats, marketId) => perpsMarketsStats[marketId],
  ),
)

export const selectSpotMarketStats = createSelector(
  [selectSpotMarketsStats, selectMarketId],
  createTracking('selectSpotMarketStats', (spotMarketStats, marketId) => spotMarketStats[marketId]),
)

const selectCommonMarketStats = createSelector(
  [selectPerpsMarketStats, selectSpotMarketStats],
  createTracking(
    'selectCommonMarketStats',
    (perpsMarketStats, spotMarketStats) => perpsMarketStats ?? spotMarketStats,
  ),
)

export const selectMarkPrice = createSelector(
  [selectPerpsMarketStats],
  createTracking('selectMarkPrice', (marketStats) => marketStats?.mark_price ?? null),
)

const selectCurrentPerpsMarketStats = createSelector(
  [selectPerpsMarketsStats, selectCurrentMarketId],
  createTracking(
    'selectCurrentPerpsMarketStats',
    (perpsMarketsStats, currentMarketId) => perpsMarketsStats[currentMarketId],
  ),
)
const selectCurrentSpotMarketStats = createSelector(
  [selectSpotMarketsStats, selectCurrentMarketId],
  createTracking(
    'selectCurrentSpotMarketStats',
    (spotMarketsStats, currentMarketId) => spotMarketsStats[currentMarketId],
  ),
)
export const selectCurrentMarketMarkPrice = createSelector(
  [selectCurrentPerpsMarketStats],
  createTracking('selectCurrentMarketMarkPrice', (marketStats) => marketStats?.mark_price ?? null),
)
export const selectCurrentMarketIndexPrice = createSelector(
  [selectCurrentSpotMarketStats],
  createTracking(
    'selectCurrentMarketIndexPrice',
    (marketStats) => marketStats?.index_price ?? null,
  ),
)
export const selectDailyPriceChange = createSelector(
  [selectCommonMarketStats],
  createTracking(
    'selectDailyPriceChange',
    (marketStats) => marketStats?.daily_price_change ?? null,
  ),
)

export const selectCurrentMarketOpenInterest = createSelector(
  [selectCurrentPerpsMarketStats],
  createTracking(
    'selectCurrentMarketOpenInterest',
    (marketStats) => marketStats?.open_interest ?? null,
  ),
)

export const selectCurrentMarketOpenInterestLimit = createSelector(
  [selectCurrentPerpsMarketStats],
  createTracking('selectOpenInterestLimit', (marketStats) => {
    const openInterestLimit = marketStats?.open_interest_limit ?? null
    const existingOiLimit =
      !!openInterestLimit && openInterestLimit < MAX_OI_LIMIT ? openInterestLimit : undefined
    const existingOiLimitScaled = existingOiLimit !== undefined ? existingOiLimit / 10 ** 6 : null
    return existingOiLimitScaled
  }),
)

export const selectIsCurrentMarketReduceOnly = createSelector(
  [selectCurrentMarket],
  createTracking('selectIsCurrentMarketReduceOnly', (market) =>
    !market || isMarketSpot(market) ? false : market.market_config.force_reduce_only,
  ),
)

export const selectIsCurrentMarketLiquidationMode = createSelector(
  [selectCurrentMarket],
  createTracking('selectIsCurrentMarketLiquidationMode', (market) =>
    isMarketSpot(market) ? false : !!market.market_config.liquidation_mode,
  ),
)

export const selectIsOpenInterestLimitReached = createSelector(
  [selectCurrentMarketOpenInterest, selectCurrentMarketOpenInterestLimit],
  createTracking(
    'selectIsOpenInterestLimitReached',
    (openInterest, openInterestLimit) =>
      openInterest !== null && openInterestLimit !== null && openInterest * 2 >= openInterestLimit,
  ),
)

export const selectDepthChartData = createSelector(
  [selectOrderBook, selectMidPrice],
  createTracking('selectDepthChartData', (orderBook, midPrice) => {
    const depthChartData = {
      prices: [] as number[],
      asksDepth: [] as number[],
      bidsDepth: [] as number[],
      maxDepth: 0,
      midPriceIndex: undefined as number | undefined,
    }

    if (!orderBook) {
      return depthChartData
    }

    const { bids, asks } = orderBook

    const depthChartBids = bids.filter((bid) => bid.price >= midPrice * 0.9)
    const depthChartAsks = asks.filter((ask) => ask.price <= midPrice * 1.1)
    const distance = Math.max(
      (depthChartAsks[depthChartAsks.length - 1]?.price ?? 0) - midPrice,
      midPrice - (depthChartBids[depthChartBids.length - 1]?.price ?? 0),
    )

    if (bids.length !== 0 && midPrice) {
      const minPrice = midPrice - distance
      const bids = accumulate(
        depthChartBids.filter((r) => r.price >= minPrice),
        minPrice,
      )
      depthChartData.prices = bids.map((r) => r.x)
      depthChartData.bidsDepth = bids.map((r) => r.y)
    }

    if (midPrice && bids.length !== 0 && asks.length !== 0) {
      depthChartData.midPriceIndex = depthChartData.prices.length
      depthChartData.prices.push(midPrice)
    }

    if (asks.length !== 0 && midPrice) {
      const maxPrice = midPrice + distance
      const asks = accumulate(
        depthChartAsks.filter((r) => r.price <= maxPrice),
        maxPrice,
      )
      depthChartData.prices = depthChartData.prices.concat(asks.map((r) => r.x))
      depthChartData.asksDepth = Array.from<number>({
        length: depthChartData.prices.length - asks.length,
      }).concat(asks.map((r) => r.y))
    }

    const maxDepthSum = Math.max(
      depthChartAsks.reduce((acc, row) => acc + row.size, 0),
      depthChartBids.reduce((acc, row) => acc + row.size, 0),
    )
    depthChartData.maxDepth = maxDepthSum > 1 ? Math.ceil(maxDepthSum) : maxDepthSum

    return depthChartData
  }),
)

const accumulate = (orders: Array<{ price: number; size: number }>, basePoint: number) => {
  if (orders.length === 0) {
    return []
  }
  const accumulated: Array<{ x: number; y: number }> = []
  let sum = 0

  for (let i = 0; i < orders.length; i += 1) {
    sum = sum + orders[i]!.size

    accumulated.push({ x: orders[i]!.price, y: sum })
  }

  if (basePoint < orders[orders.length - 1]!.price) {
    accumulated.push({ x: basePoint, y: sum })
  } else if (basePoint > orders[0]!.price) {
    accumulated.unshift({ x: basePoint, y: sum })
  }

  return accumulated.slice().sort((a, b) => a.x - b.x)
}

export const HIGHLIGHTED_MARKETS_COUNT = 5

export const selectLatestMarketsDetails = createSelector(
  [selectActiveOrderBookMetas, selectPerpsMarketsStats, selectSpotMarketsStats],
  createTracking(
    'selectLatestMarketsDetails',
    (orderBookMetas, perpsMarketsStats, spotMarketsStats) => {
      const latestMarketsDetails: Record<
        number,
        | {
            meta: SpotOrderBookDetail
            stats: WsSpotMarketStats
          }
        | {
            meta: PerpsOrderBookDetail
            stats: WsPerpsMarketStats
          }
      > = {}
      for (const metaId in orderBookMetas) {
        if (!isHiddenMarket(orderBookMetas[metaId]!)) {
          const stats = perpsMarketsStats[metaId] ?? spotMarketsStats[metaId]
          if (!stats) {
            continue
          }
          latestMarketsDetails[Number(metaId)] = {
            meta: orderBookMetas[metaId]!,
            stats: stats,
          } as
            | {
                meta: SpotOrderBookDetail
                stats: WsSpotMarketStats
              }
            | {
                meta: PerpsOrderBookDetail
                stats: WsPerpsMarketStats
              }
        }
      }
      return latestMarketsDetails
    },
  ),
)

const HIGHLIGHTED_MARKETS_LOADING_STATE = {
  topGainers: [],
  topLosers: [],
  topOpenInterest: [],
  topVolume: [],
  isLoading: true,
}
export const selectMarketHighlightStats = createSelector(
  [selectLatestMarketsDetails, selectPerpsMarketsStatsLoading, selectRwaCoins],
  createTracking(
    'selectMarketHighlightStats',
    (latestMarketsDetails, isPerpsStatsLoading, rwaCoins) => {
      if (isPerpsStatsLoading) {
        return HIGHLIGHTED_MARKETS_LOADING_STATE
      }

      const perpsMarkets = Object.values(latestMarketsDetails).filter(
        (market) => !isMarketSpot(market.meta),
      ) as Array<{
        meta: PerpsOrderBookDetail
        stats: WsPerpsMarketStats
      }>

      perpsMarkets.sort(
        (a, b) =>
          ('open_interest' in b.stats ? b.stats.open_interest : 0) -
          ('open_interest' in a.stats ? a.stats.open_interest : 0),
      )

      const topOpenInterest = perpsMarkets.slice(0, HIGHLIGHTED_MARKETS_COUNT)
      perpsMarkets.sort(
        (a, b) => b.stats.daily_quote_token_volume - a.stats.daily_quote_token_volume,
      )
      const requiredMarkets = [
        perpsMarkets.find((market) => market.meta.market_id === LIT_MARKET_ID),
        perpsMarkets.find((market) => rwaCoins.has(market.meta.backend_symbol)),
      ].filter((market) => market !== undefined)
      const topVolume = [
        ...requiredMarkets,
        ...perpsMarkets.filter((market) => !requiredMarkets.includes(market)),
      ]
        .slice(0, HIGHLIGHTED_MARKETS_COUNT)
        .sort((a, b) => b.stats.daily_quote_token_volume - a.stats.daily_quote_token_volume)

      perpsMarkets.sort((a, b) => b.stats.daily_price_change - a.stats.daily_price_change)

      const topGainers = perpsMarkets.slice(0, HIGHLIGHTED_MARKETS_COUNT)

      perpsMarkets.reverse()

      const topLosers = perpsMarkets.slice(0, HIGHLIGHTED_MARKETS_COUNT)

      return {
        topGainers,
        topLosers,
        topOpenInterest,
        topVolume,
        isLoading: false,
      }
    },
  ),
)

export const selectAllowedMarketIds = createSelector(
  [selectOrderBookMetas],
  createTracking(
    'selectAllowedMarketIds',
    (orderBookMetas) => new Set(Object.values(orderBookMetas).map((meta) => meta.market_id)),
  ),
)

export const selectAllowedAssetIds = createSelector(
  [selectAssetMetas],
  createTracking(
    'selectAllowedAssetIds',
    (assetMetas) => new Set(Object.values(assetMetas).map((meta) => meta.asset_id)),
  ),
)
