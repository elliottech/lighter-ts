import { AccountPositionSignEnum } from 'zklighter-perps'

import {
  computeEstPositionClosePnl,
  computeIsFairPriceMissing,
  computeIsPriceFarFromFairPrice,
  isLimitOrderUnsafe,
  isTriggerLimitPriceUnsafe,
} from '../../formulas/common'
import { computeSlippage, computeVeryHighSlippage } from '../../formulas/orderBook'
import { isTestingEnvironment } from '../../testing/isTestingEnvironment'
import { OrderType } from '../../types/order'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import { selectCurrentMarketPosition } from '../accounts/selectors'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import {
  selectCurrentMarketId,
  selectCurrentMarketIndexPrice,
  selectCurrentMarketMarkPrice,
  selectCurrentPerpsMarket,
  selectOrderBook,
  selectPerpsMarketsStats,
  selectSpotMarketsStats,
  selectSpreadPercentage,
} from '../orderbook/selectors'
import {
  selectDisplayedForm,
  selectMarketId,
  selectOrderType,
  type OptionalDirection,
  type OptionalLimitPrice,
  type OptionalOrderType,
  type OptionalPinnedInput,
  type OptionalPinnedValueInputValue,
} from '../params/selectors'
import type { PlaceOrderSlice } from '../place-order/createPlaceOrderSlice'
import { selectIsShort, selectReduceOnly } from '../place-order/selectors'
import type { PreferencesSlice } from '../preferences/createPreferencesSlice'
import { selectMaxSlippage } from '../preferences/selectors'
import type { TokensSlice } from '../tokens/createTokensSlice'
import type { UserSlice } from '../user/createUserSlice'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import {
  selectBaseAmount,
  selectBestPrice,
  selectDerivedSliderValue,
  selectEstPrice,
  selectLimitPrice,
  selectOrderBookOrders,
  selectPositionAwareIsShort,
  selectTriggerPrice,
} from './common'
import { selectScaleLimitOrders } from './scale'
import { selectStopLossInfo, selectTakeProfitInfo } from './sltp'

export const selectSlippage = createSelector(
  [selectEstPrice, selectBestPrice],
  createTracking('selectSlippage', computeSlippage),
)

export const selectEstPositionClosePnl: (
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
) => ReturnType<typeof computeEstPositionClosePnl> = createSelector(
  [
    selectCurrentPerpsMarket,
    selectOrderBookOrders,
    selectCurrentMarketPosition,
    selectEstPrice,
    selectBaseAmount,
  ],
  createTracking('selectEstPositionClosePnl', computeEstPositionClosePnl),
)

export const selectVeryHighSlippage = createSelector(
  [selectOrderType, selectSlippage],
  createTracking('selectVeryHighSlippage', (orderType, slippage) => {
    if (isTestingEnvironment()) {
      return false
    }

    return computeVeryHighSlippage(orderType, slippage)
  }),
)

export const selectVeryHighSpread = createSelector(
  [selectOrderType, selectMaxSlippage, selectSpreadPercentage],
  createTracking('selectVeryHighSpread', (orderType, maxSlippage, spreadPercentage) => {
    if (isTestingEnvironment()) {
      return false
    }

    return orderType === OrderType.Market && spreadPercentage > maxSlippage
  }),
)

export const selectShowLimitPriceProtectionWarning = createSelector(
  [
    selectOrderType,
    selectPositionAwareIsShort,
    selectLimitPrice,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketIndexPrice,
    selectBestPrice,
  ],
  createTracking(
    'selectShowLimitPriceProtectionWarning',
    (orderType, isShort, limitPrice, markPrice, indexPrice, bestPrice) => {
      if (isTestingEnvironment()) {
        return false
      }

      const fairPrice = markPrice ?? indexPrice
      if (orderType !== OrderType.Limit || fairPrice === null) {
        return false
      }

      return isLimitOrderUnsafe(isShort, limitPrice, fairPrice, bestPrice)
    },
  ),
)

const selectShowScalePriceProtectionWarning = createSelector(
  [
    selectOrderType,
    selectPositionAwareIsShort,
    selectScaleLimitOrders,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketIndexPrice,

    selectBestPrice,
  ],
  createTracking(
    'selectShowScalePriceProtectionWarning',
    (orderType, isShort, scaleLimitOrders, markPrice, indexPrice, bestPrice) => {
      if (isTestingEnvironment()) {
        return false
      }

      const fairPrice = markPrice ?? indexPrice

      if (orderType !== OrderType.Scale || fairPrice === null) {
        return false
      }

      return scaleLimitOrders.some((order) =>
        isLimitOrderUnsafe(isShort, order.price, fairPrice, bestPrice),
      )
    },
  ),
)

export const selectShowTriggerLimitPriceProtectionWarning = createSelector(
  [
    selectOrderType,
    selectPositionAwareIsShort,
    selectLimitPrice,
    selectTriggerPrice,
    selectStopLossInfo,
    selectTakeProfitInfo,
    selectDisplayedForm,
  ],
  createTracking(
    'selectShowTriggerLimitPriceProtectionWarning',
    (orderType, isShort, limitPrice, triggerPrice, stopLossInfo, takeProfitInfo, displayedForm) => {
      if (isTestingEnvironment()) {
        return false
      }

      switch (orderType) {
        case OrderType.Conditional:
          return isTriggerLimitPriceUnsafe(isShort, limitPrice, triggerPrice)
        case OrderType.Market:
        case OrderType.Limit:
          if (displayedForm.type === 'closePosition') {
            return false
          }
          return [stopLossInfo, takeProfitInfo].some((info) =>
            isTriggerLimitPriceUnsafe(!isShort, info.limitPrice, info.triggerPrice),
          )
        default:
          return false
      }
    },
  ),
)

export const selectShowMarketPriceProtectionWarning = createSelector(
  [
    selectOrderType,
    selectPositionAwareIsShort,
    selectEstPrice,
    selectCurrentMarketMarkPrice,
    selectCurrentMarketIndexPrice,
    selectBestPrice,
  ],
  createTracking(
    'selectShowMarketPriceProtectionWarning',
    (orderType, isShort, estPrice, markPrice, indexPrice, bestPrice) => {
      return (
        orderType === OrderType.Market &&
        computeIsPriceFarFromFairPrice(isShort, estPrice, markPrice ?? indexPrice, bestPrice)
      )
    },
  ),
)

export const selectIsMarketOrderFairPriceMissing = createSelector(
  [selectOrderType, selectCurrentMarketMarkPrice, selectCurrentMarketIndexPrice, selectBestPrice],
  createTracking(
    'selectIsMarketOrderFairPriceMissing',
    (orderType, markPrice, indexPrice, bestPrice) => {
      if (isTestingEnvironment()) {
        return false
      }

      return (
        orderType === OrderType.Market &&
        computeIsFairPriceMissing(markPrice ?? indexPrice, bestPrice)
      )
    },
  ),
)

type ExplicitMarketSide = { marketId: number; isShort: boolean }

const selectParamIsShort = <T>(_state: T, params: ExplicitMarketSide) => params.isShort
const selectParamPrice = <T>(_state: T, params: { price: number }) => params.price

const selectMarketFairPrice = createSelector(
  [selectPerpsMarketsStats, selectSpotMarketsStats, selectMarketId],
  createTracking(
    'selectMarketFairPrice',
    (perpsMarketsStats, spotMarketsStats, marketId) =>
      perpsMarketsStats[marketId]?.mark_price ?? spotMarketsStats[marketId]?.index_price ?? null,
  ),
)

const selectMarketBestPrice = createSelector(
  [
    selectOrderBook,
    selectCurrentMarketId,
    selectPerpsMarketsStats,
    selectSpotMarketsStats,
    selectMarketId,
    selectParamIsShort,
  ],
  createTracking(
    'selectMarketBestPrice',
    (orderBook, currentMarketId, perpsMarketsStats, spotMarketsStats, marketId, isShort) => {
      if (marketId === currentMarketId) {
        return (isShort ? orderBook.bids : orderBook.asks)[0]?.price ?? 0
      }
      const stats = perpsMarketsStats[marketId] ?? spotMarketsStats[marketId]
      return (isShort ? stats?.best_bid_price : stats?.best_ask_price) ?? 0
    },
  ),
)

export const selectIsPriceFarFromFairPrice = createSelector(
  [selectParamIsShort, selectParamPrice, selectMarketFairPrice, selectMarketBestPrice],
  createTracking('selectIsPriceFarFromFairPrice', computeIsPriceFarFromFairPrice),
)

export const selectIsFairPriceMissing = createSelector(
  [selectMarketFairPrice, selectMarketBestPrice],
  createTracking('selectIsFairPriceMissing', (fairPrice, bestPrice) => {
    if (isTestingEnvironment()) {
      return false
    }

    return computeIsFairPriceMissing(fairPrice, bestPrice)
  }),
)

export const selectShowEntryPriceProtectionWarning = createSelector(
  [
    selectShowLimitPriceProtectionWarning,
    selectShowScalePriceProtectionWarning,
    selectShowMarketPriceProtectionWarning,
  ],
  createTracking(
    'selectShowEntryPriceProtectionWarning',
    (
      showLimitPriceProtectionWarning,
      showScalePriceProtectionWarning,
      showMarketPriceProtectionWarning,
    ) =>
      showLimitPriceProtectionWarning ||
      showScalePriceProtectionWarning ||
      showMarketPriceProtectionWarning,
  ),
)

export const selectShowPriceProtectionWarning = createSelector(
  [
    selectShowEntryPriceProtectionWarning,
    selectShowTriggerLimitPriceProtectionWarning,
    selectIsMarketOrderFairPriceMissing,
  ],
  createTracking(
    'selectShowPriceProtectionWarning',
    (
      showEntryPriceProtectionWarning,
      showTriggerLimitPriceProtectionWarning,
      isMarketOrderFairPriceMissing,
    ) => {
      if (isTestingEnvironment()) {
        return false
      }

      return (
        showEntryPriceProtectionWarning ||
        showTriggerLimitPriceProtectionWarning ||
        isMarketOrderFairPriceMissing
      )
    },
  ),
)

export const selectFlipsOppositeSidePosition = createSelector(
  [
    selectIsShort,
    selectReduceOnly,
    selectCurrentMarketPosition,
    selectDerivedSliderValue,
    selectBaseAmount,
  ],
  createTracking(
    'selectFlipsOppositeSidePosition',
    (isShort, reduceOnly, position, sliderValue, baseAmount) => {
      if (isTestingEnvironment()) {
        return false
      }

      if (reduceOnly) {
        return false
      }

      const positionSize = position?.position ?? 0
      if (positionSize === 0) {
        return false
      }

      const isOppositeSide = (position?.sign === AccountPositionSignEnum.Long) === isShort
      if (!isOppositeSide) {
        return false
      }

      if (Number(sliderValue) <= 50) {
        return false
      }

      return baseAmount > positionSize
    },
  ),
)

export const selectShowOppositeSidePositionWarning = createSelector(
  [selectOrderType, selectFlipsOppositeSidePosition],
  createTracking(
    'selectShowOppositeSidePositionWarning',
    (orderType, flipsOppositeSidePosition) =>
      (orderType === OrderType.Market || orderType === OrderType.Twap) && flipsOppositeSidePosition,
  ),
)
