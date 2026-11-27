import { mapValues, pickBy } from 'lodash-es'
import {
  AccountAccountTradingModeEnum,
  AccountPositionMarginModeEnum,
  AccountPositionSignEnum,
} from 'zklighter-perps'

import { computeBOLockedBalance } from '../../formulas/boOrderMargin'
import {
  computeBOEquity,
  computeCrossCollateral,
  computeCrossLeverage,
  computeDisplayTotalUnrealizedPnl,
  getPositionPnlPrice,
  computeInitialMarginReq,
  computeLiqCollateral,
  computeMarginUsage,
  computePerpsEquity,
  computePositionsLiqPrices,
  computeSpotEquity,
  computeTotalAccountLiquidationValue,
  computeTotalAccountValue,
  computeTotalMaintenanceMarginReq,
  computeTotalUnrealizedPnl,
  marginFractionToLeverage,
} from '../../formulas/common'
import { computeMatchInfo, computeSinglePriceMatchInfo } from '../../formulas/matchInfo'
import {
  computeAvailableLiquidity,
  computeMarketOrderPrice,
  computeNotEnoughLiquidity,
  computeTWAPOrderPrice,
  type MatchInfo,
} from '../../formulas/orderBook'
import {
  computeAvailableBalancesToTransfer,
  computeAvailableMarginForLimitOrders,
  computeAvailableMarginForMarketOrders,
  computeAvailableOrderMargin,
  computeAvailableToDemarginize,
  computeAvailableToTransferPools,
  computeClassicAvailablePerpsUSDCToTransfer,
  computePositionMarginOffset,
  computePositionOrderMarginOffset,
  computeSpotAvailableToTradeLimit,
  computeSpotAvailableToTradeMarket,
  computeSpotBuyAutoSupplyCredit,
} from '../../formulas/orderMargin'
import {
  computeAverageLimitPrice,
  computeScaleOrderPrices,
  computeSizeDistribution,
} from '../../formulas/scale'
import {
  computePerpsSliderMaxBaseAmount,
  computeSpotSliderMaxBaseAmount,
} from '../../formulas/updatedStats'
import type { WsPerpsMarketStats } from '../../lighter-ws/types/WsMessage'
import { OrderType } from '../../types/order'
import { convertBaseToFloat } from '../../utils/common'
import { getDefaultMarketMarginModeFromFlags, isMarketIsolatedOnly } from '../../utils/marketFlags'
import { displayPriceToReal } from '../../utils/multiplier'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import {
  selectAccountTradingMode,
  selectActiveOrders,
  selectActiveOrdersLoading,
  selectAssetBalance,
  selectAssetBalances,
  selectBOActiveOrders,
  selectBOPositions,
  selectCrossPositions,
  selectCurrentMarketPosition,
  selectMarginMode,
  selectPositions,
  selectPositionsLoading,
  selectRawAssetBalances,
  selectRawBOPositions,
  selectRawPosition,
  selectRawPositions,
  selectTotalAllocatedMargin,
} from '../accounts/selectors'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import { selectPerpsOrderBookMetas, selectSpotOrderBookMetas } from '../orderbook/metadataSelectors'
import {
  computeDisplayOrderBook,
  selectAssetIndexPrice,
  selectAssetIndexPrices,
  selectAssetMeta,
  selectAssetMetas,
  selectAssetsStats,
  selectBOMarketsStats,
  selectCurrentMarket,
  selectCurrentMarketId,
  selectCurrentMarketIndexPrice,
  selectCurrentMarketMarkPrice,
  selectCurrentMarketOrderBookMultiplier,
  selectCurrentPerpsMarket,
  selectFeeTierConfigs,
  selectIsCurrentMarketSpot,
  selectMarkPrice,
  selectMidPrice,
  selectOrderBook,
  selectOrderBookLoading,
  selectOrderBookMeta,
  selectOrderBookMetasLoaded,
  selectParamCount,
  selectPerpsMarketStats,
  selectPerpsMarketsStats,
  selectPerpsOrderBookMeta,
  USDC_ASSET_ID,
} from '../orderbook/selectors'
import {
  selectAssetId,
  selectDisplayedForm,
  selectLimitPriceInputValue,
  selectMarketId,
  selectOrderType,
  selectPinnedInput,
  selectPinnedValueInputValue,
  type OptionalDirection,
  type OptionalLimitPrice,
  type OptionalOrderType,
  type OptionalPinnedInput,
  type OptionalPinnedValueInputValue,
} from '../params/selectors'
import type { PlaceOrderSlice } from '../place-order/createPlaceOrderSlice'
import {
  selectIsShort,
  selectReduceOnly,
  selectScaleInputValue,
  selectTimeInForce,
  selectTriggerPriceInputValue,
} from '../place-order/selectors'
import type { PreferencesSlice } from '../preferences/createPreferencesSlice'
import { selectMaxSlippage } from '../preferences/selectors'
import type { TokensSlice } from '../tokens/createTokensSlice'
import { selectRwaCoins, selectTokens } from '../tokens/selectors'
import type { PerpsOrderBookDetail } from '../../types/compatibility'
import type { Position } from '../types'
import type { UserSlice } from '../user/createUserSlice'
import { selectFeeTicks, selectUserTierName } from '../user/selectors'
import { createDeepEqualSelector } from '../utils/createDeepEqualSelector'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

export const extractRelevantMarkPrices = (
  perpsMarketsStats: Record<string, WsPerpsMarketStats>,
  pickCriteria: ({ market_id }: { market_id: number }) => boolean,
) => mapValues(pickBy(perpsMarketsStats, pickCriteria), (marketStats) => marketStats.mark_price)

const extractRelevantMidPrices = (
  perpsMarketsStats: Record<string, WsPerpsMarketStats>,
  pickCriteria: ({ market_id }: { market_id: number }) => boolean,
) => mapValues(pickBy(perpsMarketsStats, pickCriteria), (marketStats) => marketStats.mid_price)

const extractRelevantClosePrices = (
  positions: Record<string, Position>,
  perpsMarketsStats: Record<string, WsPerpsMarketStats>,
) => {
  const result: Record<string, number> = {}
  for (const marketId in positions) {
    const position = positions[marketId]
    if (position?.position) {
      const stats = perpsMarketsStats[marketId]
      if (stats) {
        const price =
          position.sign === AccountPositionSignEnum.Long
            ? stats.best_bid_price
            : stats.best_ask_price
        result[marketId] = price || stats.mid_price
      }
    }
  }
  return result
}

export const selectPositionsMarkPrices = createDeepEqualSelector(
  [selectPositions, selectPerpsMarketsStats],
  createTracking('selectPositionsMarkPrices', (positions, perpsMarketsStats) =>
    extractRelevantMarkPrices(
      perpsMarketsStats,
      ({ market_id }) => !!positions[market_id]?.position,
    ),
  ),
)

export const selectPositionsMidPrices = createDeepEqualSelector(
  [selectPositions, selectPerpsMarketsStats],
  createTracking('selectPositionsMidPrices', (positions, perpsMarketsStats) =>
    extractRelevantMidPrices(
      perpsMarketsStats,
      ({ market_id }) => !!positions[market_id]?.position,
    ),
  ),
)

export const selectPositionsClosePrices = createDeepEqualSelector(
  [selectPositions, selectPerpsMarketsStats],
  createTracking('selectPositionsClosePrices', extractRelevantClosePrices),
)

export const selectActiveOrdersMarkPrices = createDeepEqualSelector(
  [selectActiveOrders, selectPerpsMarketsStats],
  createTracking('selectActiveOrdersMarkPrices', (activeOrders, perpsMarketsStats) =>
    extractRelevantMarkPrices(
      perpsMarketsStats,
      ({ market_id }) => !!activeOrders[market_id]?.length,
    ),
  ),
)

export const selectActiveOrdersSpotIndexPrices = createDeepEqualSelector(
  [selectActiveOrders, selectSpotOrderBookMetas, selectAssetsStats],
  createTracking(
    'selectActiveOrdersSpotIndexPrices',
    (activeOrders, spotOrderBookMetas, assetsStats): Record<string, number> =>
      pickBy(
        mapValues(
          pickBy(spotOrderBookMetas, ({ market_id }) => !!activeOrders[market_id]?.length),
          ({ base_asset_id }) => assetsStats[base_asset_id]?.index_price,
        ),
        (indexPrice) => indexPrice !== undefined,
      ),
  ),
)

const selectOrderMarginMarkPrices = createDeepEqualSelector(
  [selectActiveOrders, selectPositions, selectCurrentMarketId, selectPerpsMarketsStats],
  createTracking(
    'selectOrderMarginMarkPrices',
    (activeOrders, positions, currentMarketId, perpsMarketsStats) =>
      extractRelevantMarkPrices(
        perpsMarketsStats,
        ({ market_id }) =>
          !!positions[market_id]?.position ||
          !!activeOrders[market_id]?.length ||
          market_id === currentMarketId,
      ),
  ),
)

export const selectCurrentMarketActiveOrders = createSelector(
  [selectActiveOrders, selectCurrentMarketId],
  createTracking(
    'selectCurrentMarketActiveOrders',
    (activeOrders, marketId) => activeOrders[marketId],
  ),
)

export const selectPositionAwareIsShort: (
  state: AccountsSlice & OrderBookSlice & PlaceOrderSlice & PreferencesSlice & UserSlice,
  params?: OptionalDirection & OptionalOrderType,
) => boolean = createSelector(
  [selectIsShort, selectCurrentMarketPosition, selectDisplayedForm],
  createTracking('selectPositionAwareIsShort', (isShort, position, displayedForm) => {
    if (displayedForm.type === 'closePosition' && !!position) {
      return position.sign === AccountPositionSignEnum.Long
    }

    return isShort
  }),
)

export const selectLimitPrice = createSelector(
  [selectLimitPriceInputValue, selectCurrentMarket, selectPositionAwareIsShort],
  createTracking('selectLimitPrice', (limitPriceInputValue, currentMarket, isShort) =>
    displayPriceToReal(limitPriceInputValue, currentMarket, isShort),
  ),
)

export const selectTriggerPrice = createSelector(
  [selectTriggerPriceInputValue, selectCurrentMarket, selectPositionAwareIsShort],
  createTracking('selectTriggerPrice', displayPriceToReal),
)

export const selectScale = createSelector(
  [selectScaleInputValue, selectCurrentMarket, selectPositionAwareIsShort],
  createTracking('selectScale', (scale, currentMarket, isShort) => ({
    startPrice: displayPriceToReal(scale.startPriceInputValue, currentMarket, isShort),
    endPrice: displayPriceToReal(scale.endPriceInputValue, currentMarket, isShort),
    orderCount: Number(scale.orderCountInputValue),
    skew: Number(scale.skewInputValue),
  })),
)

export const selectScaleOrderPrices = createSelector(
  [selectScale, selectCurrentMarket],
  createTracking('selectScaleOrderPrices', (scale, currentMarket) =>
    computeScaleOrderPrices(
      scale.startPrice,
      scale.endPrice,
      scale.orderCount,
      currentMarket.price_decimals,
    ),
  ),
)

export const selectScaleSizeDistribution = createSelector(
  [selectScale],
  createTracking('selectScaleSizeDistribution', (scale) =>
    computeSizeDistribution(scale.orderCount, scale.skew),
  ),
)

export const selectScaleAverageLimitPrice = createSelector(
  [selectScaleOrderPrices, selectScaleSizeDistribution, selectCurrentMarket],
  createTracking('selectScaleAverageLimitPrice', (prices, sizes, currentMarket) =>
    convertBaseToFloat(computeAverageLimitPrice(prices, sizes), currentMarket.price_decimals),
  ),
)

export const selectOrderBookOrders = createSelector(
  [selectOrderBook, selectPositionAwareIsShort],
  createTracking('selectOrderBookOrders', ({ asks, bids }, isShort) => (isShort ? bids : asks)),
)

export const selectBestPrice = createSelector(
  [selectOrderBookOrders],
  createTracking('selectBestPrice', (orders) => orders[0]?.price ?? 0),
)

export const selectAvailableLiquidity = createSelector(
  [selectOrderBookOrders, selectCurrentMarket],
  createTracking('selectAvailableLiquidity', computeAvailableLiquidity),
)

export const selectMarketOrderPrice = createSelector(
  [selectMaxSlippage, selectPositionAwareIsShort, selectOrderBookOrders],
  createTracking('selectMarketOrderPrice', computeMarketOrderPrice),
)

export const selectTWAPOrderPrice = createSelector(
  [
    selectIsShort,
    selectIsCurrentMarketSpot,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketIndexPrice,
  ],
  createTracking('selectTWAPOrderPrice', computeTWAPOrderPrice),
)

export const selectCurrentMarketInitialMarginFraction = createSelector(
  [selectCurrentPerpsMarket, selectCurrentMarketPosition],
  createTracking(
    'selectCurrentMarketInitialMarginFraction',
    (perpsMarket, position) =>
      position?.initial_margin_fraction ?? perpsMarket?.default_initial_margin_fraction ?? 10000,
  ),
)

export const selectMarketsInitialMarginFraction = createSelector(
  [selectPerpsOrderBookMetas, selectRawPositions],
  createTracking('selectMarketsInitialMarginFraction', (perpsOrderBookMetas, positions) => {
    if (!perpsOrderBookMetas || !positions) return null
    const result: Record<string, number> = {}
    for (const marketId in perpsOrderBookMetas) {
      result[marketId] =
        positions[marketId]?.initial_margin_fraction ??
        perpsOrderBookMetas[marketId]?.default_initial_margin_fraction ??
        0
    }
    return result
  }),
)

export interface MaxLeverageMarketUpdate {
  market: PerpsOrderBookDetail
  from: number
  to: number
  marginMode: AccountPositionMarginModeEnum
  initialMarginFraction: number
}

export const selectMaxLeverageMarketUpdates = createDeepEqualSelector(
  [
    selectRawPositions,
    selectPositionsLoading,
    selectActiveOrders,
    selectActiveOrdersLoading,
    selectPerpsOrderBookMetas,
    selectOrderBookMetasLoaded,
  ],
  createTracking(
    'selectMaxLeverageMarketUpdates',
    (
      rawPositions,
      positionsLoading,
      activeOrders,
      activeOrdersLoading,
      markets,
      orderBookMetasLoaded,
    ): MaxLeverageMarketUpdate[] => {
      if (positionsLoading || activeOrdersLoading || !orderBookMetasLoaded) return []

      const marketIds = new Set([
        ...Object.entries(rawPositions ?? {}).flatMap(([marketId, position]) =>
          position.position !== 0 ? [marketId] : [],
        ),
        ...Object.entries(activeOrders).flatMap(([marketId, orders]) =>
          orders.length > 0 ? [marketId] : [],
        ),
      ])

      return Array.from(marketIds).flatMap((marketIdValue) => {
        const marketId = Number(marketIdValue)
        const market = markets[marketId]
        if (!market) return []

        const position = rawPositions?.[marketId]
        const marginMode =
          position?.margin_mode ?? getDefaultMarketMarginModeFromFlags(market.market_flags)
        const initialMarginFraction =
          position?.initial_margin_fraction ?? market.default_initial_margin_fraction

        if (
          marginMode !== AccountPositionMarginModeEnum.Cross ||
          initialMarginFraction <= market.min_initial_margin_fraction
        ) {
          return []
        }

        return [
          {
            market,
            from: marginFractionToLeverage(initialMarginFraction),
            to: marginFractionToLeverage(market.min_initial_margin_fraction),
            marginMode,
            initialMarginFraction: market.min_initial_margin_fraction,
          },
        ]
      })
    },
  ),
)

export const selectSpotEquity = createSelector(
  [selectAssetIndexPrices, selectRawAssetBalances],
  createTracking('selectSpotEquity', computeSpotEquity),
)

export const selectBOEquity = createSelector(
  [selectBOMarketsStats, selectRawBOPositions],
  createTracking('selectBOEquity', computeBOEquity),
)

const selectCrossUnrealizedPnl = createSelector(
  [selectPositionsMarkPrices, selectCrossPositions],
  createTracking('selectCrossUnrealizedPnl', computeTotalUnrealizedPnl),
)

const selectTotalUnrealizedPnl = createSelector(
  [selectPositionsMarkPrices, selectRawPositions],
  createTracking('selectTotalUnrealizedPnl', computeTotalUnrealizedPnl),
)

export const selectStrategiesUnrealizedPnl = createSelector(
  [selectPositionsMarkPrices, selectRawPositions, selectPerpsOrderBookMetas],
  createTracking('selectStrategiesUnrealizedPnl', (markPrices, positions, perpsOrderBookMetas) => {
    if (!positions) {
      return null
    }

    const positionsByStrategy: Record<number, Record<string, Position>> = {}
    for (const [marketId, position] of Object.entries(positions)) {
      const strategyIndex = perpsOrderBookMetas[marketId]?.strategy_index
      if (strategyIndex === undefined) {
        continue
      }
      positionsByStrategy[strategyIndex] ??= {}
      positionsByStrategy[strategyIndex][marketId] = position
    }

    return mapValues(
      positionsByStrategy,
      (strategyPositions) => computeTotalUnrealizedPnl(markPrices, strategyPositions) ?? 0,
    )
  }),
)

export const selectDisplayTotalUnrealizedPnl = createSelector(
  [
    selectPositionsMarkPrices,
    selectPositionsMidPrices,
    selectRawPositions,
    selectPerpsOrderBookMetas,
    selectRwaCoins,
  ],
  createTracking('selectDisplayTotalUnrealizedPnl', computeDisplayTotalUnrealizedPnl),
)

export const selectPositionPnlPrice = createSelector(
  [selectMarkPrice, selectPerpsMarketStats, selectPerpsOrderBookMeta, selectRwaCoins],
  createTracking('selectPositionPnlPrice', (markPrice, marketStats, market, rwaCoins) =>
    getPositionPnlPrice({
      markPrice: markPrice ?? 0,
      midPrice: marketStats?.mid_price,
      isRwaMarket: !!market && rwaCoins.has(market.backend_symbol),
    }),
  ),
)

export const selectPerpsEquity = createSelector(
  [selectTotalAllocatedMargin, selectTotalUnrealizedPnl, selectRawAssetBalances],
  createTracking('selectPerpsEquity', computePerpsEquity),
)

export const selectTradingEquity = createSelector(
  [selectPerpsEquity, selectSpotEquity],
  createTracking('selectTradingEquity', (perpsEquity, spotEquity) =>
    perpsEquity === null || spotEquity === null ? null : perpsEquity + spotEquity,
  ),
)

export const selectCrossInitialMarginReq = createSelector(
  [selectPositionsMarkPrices, selectCrossPositions],
  createTracking('selectCrossInitialMarginReq', computeInitialMarginReq),
)

export const selectCrossMaintenanceMarginReq = createSelector(
  [selectPositionsMarkPrices, selectPerpsOrderBookMetas, selectCrossPositions],
  createTracking('selectCrossMaintenanceMarginReq', computeTotalMaintenanceMarginReq),
)

export const selectInitialMarginFraction = createSelector(
  [selectPerpsOrderBookMeta, selectRawPosition],
  createTracking(
    'selectInitialMarginFraction',
    (perpsMarket, position) =>
      position?.initial_margin_fraction ?? perpsMarket?.default_initial_margin_fraction ?? 0,
  ),
)

const selectParamPercentageRange = <ParamsT extends { percentageRange?: number }>(
  _state: unknown,
  params: ParamsT,
) => params.percentageRange

export const selectDisplayOrderBook = createSelector(
  [
    selectOrderBook,
    selectCurrentMarket,
    selectCurrentMarketOrderBookMultiplier,
    selectCurrentMarketActiveOrders,
    selectParamCount,
    selectParamPercentageRange,
  ],
  createTracking('selectDisplayOrderBook', computeDisplayOrderBook),
)

export const selectLiqCollateral = createSelector(
  [selectAssetMetas, selectRawAssetBalances, selectAssetIndexPrices],
  createTracking('selectLiqCollateral', computeLiqCollateral),
)

const selectCrossCollateral = createSelector(
  [selectAssetMetas, selectRawAssetBalances, selectAssetIndexPrices],
  createTracking('selectCrossCollateral', computeCrossCollateral),
)

const selectTotalAccountLiquidationValue = createSelector(
  [selectLiqCollateral, selectCrossUnrealizedPnl],
  createTracking('selectTotalAccountLiquidationValue', computeTotalAccountLiquidationValue),
)

export const selectCrossTotalAccountValue = createSelector(
  [selectCrossCollateral, selectCrossUnrealizedPnl],
  createTracking('selectCrossTotalAccountValue', computeTotalAccountValue),
)

export const selectCrossLeverage = createSelector(
  [selectCrossTotalAccountValue, selectPositionsMarkPrices, selectCrossPositions],
  createTracking('selectCrossLeverage', computeCrossLeverage),
)

export const selectCrossInitialMarginUsage = createSelector(
  [selectCrossTotalAccountValue, selectCrossInitialMarginReq],
  createTracking('selectCrossInitialMarginUsage', computeMarginUsage),
)

export const selectCrossMaintenanceMarginUsage = createSelector(
  [selectTotalAccountLiquidationValue, selectCrossMaintenanceMarginReq],
  createTracking('selectCrossMaintenanceMarginUsage', computeMarginUsage),
)

export const selectBOLockedBalance = createSelector(
  [selectBOPositions, selectBOActiveOrders],
  createTracking('selectBOLockedBalance', computeBOLockedBalance),
)

const selectAvailableOrderMargin = createSelector(
  [
    selectPerpsOrderBookMetas,
    selectOrderMarginMarkPrices,
    selectRawPositions,
    selectActiveOrders,
    selectRawAssetBalances,
    selectCrossTotalAccountValue,
    selectCrossInitialMarginReq,
    selectBOLockedBalance,
  ],
  createTracking('selectAvailableOrderMargin', computeAvailableOrderMargin),
)

export const selectHasMarginReservedByActiveOrders = createSelector(
  [selectCrossTotalAccountValue, selectCrossInitialMarginReq, selectAvailableOrderMargin],
  createTracking(
    'selectHasMarginReservedByActiveOrders',
    (tav, imr, availableOrderMargin) =>
      tav !== null &&
      imr !== null &&
      availableOrderMargin !== null &&
      tav - imr > availableOrderMargin,
  ),
)

const selectPositionMarginOffset = createSelector(
  [
    selectIsCurrentMarketSpot,
    selectPositionAwareIsShort,
    selectCurrentMarketInitialMarginFraction,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketPosition,
  ],
  createTracking('selectPositionMarginOffset', computePositionMarginOffset),
)

const selectPositionOrderMarginOffset = createSelector(
  [
    selectIsCurrentMarketSpot,
    selectPositionAwareIsShort,
    selectCurrentMarketInitialMarginFraction,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketActiveOrders,
    selectCurrentMarketPosition,
  ],
  createTracking('selectPositionOrderMarginOffset', computePositionOrderMarginOffset),
)

export const selectAvailableMarginForLimitOrders = createSelector(
  [
    selectAvailableOrderMargin,
    selectAssetBalances,
    selectPositionOrderMarginOffset,
    selectCurrentMarketPosition,
  ],
  createTracking('selectAvailableMarginForLimitOrders', computeAvailableMarginForLimitOrders),
)

export const selectAvailableToDemarginize = createSelector(
  [
    selectCrossTotalAccountValue,
    selectCrossInitialMarginReq,
    selectAssetIndexPrice,
    selectAssetBalance,
    selectAssetMeta,
  ],
  createTracking('selectAvailableToDemarginize', computeAvailableToDemarginize),
)

const selectAvailableMarginForMarketOrders = createSelector(
  [
    selectCrossTotalAccountValue,
    selectCrossInitialMarginReq,
    selectAssetBalances,
    selectPositionMarginOffset,
    selectCurrentMarketPosition,
  ],
  createTracking('selectAvailableMarginForMarketOrders', computeAvailableMarginForMarketOrders),
)

const selectSpotAvailableToTradeMarket = createSelector(
  [
    selectAssetMeta,
    selectRawAssetBalances,
    selectCurrentMarket,
    selectAssetIndexPrice,
    selectIsShort,
    selectCrossTotalAccountValue,
    selectCrossInitialMarginReq,
  ],
  createTracking('selectSpotAvailableToTradeMarket', computeSpotAvailableToTradeMarket),
)

const selectSpotAvailableToTradeLimit = createSelector(
  [
    selectAssetMeta,
    selectRawAssetBalances,
    selectCurrentMarket,
    selectAssetIndexPrice,
    selectIsShort,
    selectAvailableOrderMargin,
    selectBOLockedBalance,
  ],
  createTracking('selectSpotAvailableToTradeLimit', computeSpotAvailableToTradeLimit),
)

export const selectAvailableToTrade = createSelector(
  [
    selectSpotAvailableToTradeMarket,
    selectAvailableMarginForMarketOrders,
    selectIsCurrentMarketSpot,
  ],
  createTracking('selectAvailableToTrade', (spotAvailableToTrade, perpsAvailableToTrade, isSpot) =>
    isSpot ? spotAvailableToTrade : perpsAvailableToTrade,
  ),
)

export const selectClassicAvailablePerpsUSDCToTransfer = createSelector(
  [selectAvailableOrderMargin, selectRawAssetBalances],
  createTracking(
    'selectClassicAvailablePerpsUSDCToTransfer',
    computeClassicAvailablePerpsUSDCToTransfer,
  ),
)

export const selectAvailableBalancesToTransfer = createSelector(
  [
    selectAssetMetas,
    selectRawAssetBalances,
    selectAssetIndexPrices,
    selectAvailableOrderMargin,
    selectBOLockedBalance,
  ],
  createTracking('selectAvailableBalancesToTransfer', computeAvailableBalancesToTransfer),
)

export const selectAvailableBalanceToTransfer = createSelector(
  [selectAvailableBalancesToTransfer, selectAssetId],
  createTracking(
    'selectAvailableBalanceToTransfer',
    (balances, assetId) => balances?.[assetId] ?? null,
  ),
)

export const selectAvailablePublicPoolBalance = createSelector(
  [selectCrossTotalAccountValue, selectCrossInitialMarginReq, selectRawAssetBalances],
  createTracking('selectAvailablePublicPoolBalance', computeAvailableToTransferPools),
)

const selectPriceForOrderMarginConversion = createSelector(
  [selectOrderType, selectLimitPrice, selectScaleAverageLimitPrice, selectMidPrice],
  createTracking(
    'selectPriceForOrderMarginConversion',
    (orderType, limitPrice, scaleAverageLimitPrice, midPrice) => {
      switch (orderType) {
        case OrderType.Market:
          return 0 // not used
        case OrderType.Conditional:
          return limitPrice || midPrice
        case OrderType.Twap:
          return midPrice
        case OrderType.Limit:
          return limitPrice
        case OrderType.Scale:
          return scaleAverageLimitPrice
      }
    },
  ),
)

const selectAvailableMarginForLimitOrdersInBaseAmount = createSelector(
  [
    selectCurrentMarket,
    selectAvailableMarginForLimitOrders,
    selectPriceForOrderMarginConversion,
    selectCurrentMarketInitialMarginFraction,
  ],
  createTracking(
    'selectAvailableMarginForLimitOrdersInBaseAmount',
    (currentMarket, availableMargin, conversionPrice, imf) => {
      if (availableMargin === null) {
        return null
      }

      const { baseAmount } = computeSinglePriceMatchInfo(
        'quote',
        (availableMargin * marginFractionToLeverage(imf)).toFixed(currentMarket.price_decimals),
        0,
        conversionPrice,
        currentMarket,
      )

      return baseAmount
    },
  ),
)

const selectPerpsSliderMax = createSelector(
  [
    selectUserTierName,
    selectCurrentMarket,
    selectReduceOnly,
    selectOrderBookOrders,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketInitialMarginFraction,
    selectCurrentMarketPosition,
    selectOrderType,
    selectPositionAwareIsShort,
    selectAvailableMarginForMarketOrders,
    selectAvailableMarginForLimitOrdersInBaseAmount,
    selectFeeTicks,
    selectTimeInForce,
    selectFeeTierConfigs,
    selectPriceForOrderMarginConversion,
  ],
  createTracking('selectPerpsSliderMax', computePerpsSliderMaxBaseAmount),
)

export const selectCanPlaceLimitOrderFullAmount = createSelector(
  [selectAccountTradingMode, selectCrossInitialMarginReq],
  createTracking('selectCanPlaceLimitOrderFullAmount', (accountTradingMode, imr) => {
    if (accountTradingMode === null || imr === null) {
      return false
    }

    return accountTradingMode === AccountAccountTradingModeEnum.Simple || imr === 0
  }),
)

const selectSpotBuyAutoSupplyCredit = createSelector(
  [selectCurrentMarket, selectAssetMetas, selectAssetBalances, selectAssetsStats],
  createTracking('selectSpotBuyAutoSupplyCredit', computeSpotBuyAutoSupplyCredit),
)

const selectCurrentMarketQuoteAssetBalance = createSelector(
  [selectCurrentMarket, selectAssetBalances],
  createTracking(
    'selectCurrentMarketQuoteAssetBalance',
    (currentMarket, assetBalances) => assetBalances[currentMarket.quote_asset_id],
  ),
)

const selectSpotSliderMax = createSelector(
  [
    selectCurrentMarket,
    selectOrderBookOrders,
    selectOrderType,
    selectIsShort,
    selectSpotAvailableToTradeMarket,
    selectSpotAvailableToTradeLimit,
    selectPriceForOrderMarginConversion,
    selectCanPlaceLimitOrderFullAmount,
    selectSpotBuyAutoSupplyCredit,
    selectCurrentMarketQuoteAssetBalance,
  ],
  createTracking('selectSpotSliderMax', computeSpotSliderMaxBaseAmount),
)

export const selectSliderMax = createSelector(
  [selectIsCurrentMarketSpot, selectPerpsSliderMax, selectSpotSliderMax],
  createTracking('selectSliderMax', (isCurrentMarketSpot, perpsSliderMax, spotSliderMax) =>
    isCurrentMarketSpot ? spotSliderMax : perpsSliderMax,
  ),
)

const selectMatchInfo: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: OptionalOrderType &
    OptionalPinnedInput &
    OptionalPinnedValueInputValue &
    OptionalLimitPrice &
    OptionalDirection,
) => MatchInfo = createSelector(
  [
    selectOrderType,
    selectPinnedInput,
    selectPinnedValueInputValue,
    selectLimitPrice,
    selectMidPrice,
    selectOrderBookOrders,
    selectCurrentMarket,
    selectScaleAverageLimitPrice,
    selectSliderMax,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketIndexPrice,
    selectAvailableLiquidity,
  ],
  createTracking(
    'selectMatchInfo',
    (
      orderType,
      pinnedInput,
      pinnedValueInputValue,
      limitPrice,
      midPrice,
      orderBookOrders,
      currentMarket,
      scaleAverageLimitPrice,
      sliderMax,
      markPrice,
      indexPrice,
      availableLiquidity,
    ) =>
      computeMatchInfo(
        orderType,
        pinnedInput,
        pinnedValueInputValue,
        limitPrice,
        midPrice,
        orderBookOrders,
        currentMarket,
        scaleAverageLimitPrice,
        sliderMax,
        markPrice ?? indexPrice ?? 0,
        availableLiquidity,
      ),
  ),
)

export const selectEstPrice = createSelector(
  [selectMatchInfo],
  createTracking('selectEstPrice', (matchInfo) => matchInfo.estPrice),
)
export const selectBaseAmount = createSelector(
  [selectMatchInfo],
  createTracking('selectBaseAmount', (matchInfo) => matchInfo.baseAmount),
)

export const selectQuoteAmount = createSelector(
  [selectMatchInfo],
  createTracking('selectQuoteAmount', (matchInfo) => matchInfo.quoteAmount),
)

export const selectBaseAmountInputValue = createSelector(
  [selectMatchInfo],
  createTracking('selectBaseAmountInputValue', (matchInfo) => matchInfo.baseAmountInputValue),
)

export const selectQuoteAmountInputValue = createSelector(
  [selectMatchInfo],
  createTracking('selectQuoteAmountInputValue', (matchInfo) => matchInfo.quoteAmountInputValue),
)

export const selectNotEnoughLiquidity = createSelector(
  [selectOrderType, selectOrderBookLoading, selectAvailableLiquidity, selectBaseAmount],
  createTracking('selectNotEnoughLiquidity', computeNotEnoughLiquidity),
)

export const selectDerivedSliderValue: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: OptionalOrderType &
    OptionalPinnedInput &
    OptionalPinnedValueInputValue &
    OptionalLimitPrice &
    OptionalDirection,
) => string = createSelector(
  [selectPinnedInput, selectPinnedValueInputValue, selectBaseAmount, selectSliderMax],
  createTracking(
    'selectDerivedSliderValue',
    (pinnedInput, pinnedValueInputValue, baseAmount, sliderMax) => {
      if (pinnedInput === 'percentage') {
        return pinnedValueInputValue
      }

      if (sliderMax === 0) {
        return '0'
      }

      return Math.min((baseAmount / sliderMax) * 100, 100).toFixed(0)
    },
  ),
)

export const selectLiqPrices = createSelector(
  [
    selectPositionsMarkPrices,
    selectPerpsOrderBookMetas,
    selectCrossMaintenanceMarginReq,
    selectTotalAccountLiquidationValue,
    selectRawPositions,
  ],
  createTracking('selectLiqPrices', computePositionsLiqPrices),
)

export const selectLiqPrice = createSelector(
  [selectLiqPrices, selectMarketId],
  createTracking('selectLiqPrice', (liqPrices, marketId) => liqPrices[marketId]),
)

export const selectIsCurrentMarketIsolatedOnly = createSelector(
  [selectCurrentMarket],
  createTracking('selectIsCurrentMarketIsolatedOnly', isMarketIsolatedOnly),
)

const selectIsMarketIsolatedOnly = createSelector(
  [selectOrderBookMeta],
  createTracking('selectIsMarketIsolatedOnly', isMarketIsolatedOnly),
)

export const selectIsMarginModeChangeRequired = createSelector(
  [selectIsMarketIsolatedOnly, selectMarginMode, selectRawPosition],
  createTracking(
    'selectIsMarginModeChangeRequired',
    (isIsolatedOnly, marginMode, position) =>
      isIsolatedOnly && marginMode === AccountPositionMarginModeEnum.Cross && !position?.position,
  ),
)

export const selectCanModifyAccountTradingMode = createSelector(
  [
    selectAccountTradingMode,
    selectRawAssetBalances,
    selectCrossTotalAccountValue,
    selectCrossInitialMarginReq,
  ],
  createTracking(
    'selectCanModifyAccountTradingMode',
    (accountTradingMode, assetBalances, tav, imr) => {
      if (accountTradingMode === null || !assetBalances || tav === null || imr === null) {
        return false
      }

      if (accountTradingMode === AccountAccountTradingModeEnum.Simple) {
        return true
      }

      if (
        Object.values(assetBalances).some((assetBalance) => {
          if (assetBalance.asset_id === USDC_ASSET_ID) {
            return assetBalance.locked_balance !== 0
          }

          return assetBalance.margin_mode === 'enabled'
        }) ||
        tav < imr
      ) {
        return false
      }

      return true
    },
  ),
)

export const selectActiveTokens = createSelector(
  [selectTokens],
  createTracking('selectActiveTokens', (tokens) => {
    if (!tokens) return []
    return tokens.filter((t) => t.is_allowed_mainnet)
  }),
)
