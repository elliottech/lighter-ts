import { computeEstPositionClosePnl, isLimitOrderUnsafe } from '../../formulas/common'
import { computeSlippage } from '../../formulas/orderBook'
import { isTestingEnvironment } from '../../testing/isTestingEnvironment'
import { OrderType } from '../../types/order'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import { selectCurrentMarketPosition } from '../accounts/selectors'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import {
  selectCurrentMarketIndexPrice,
  selectCurrentMarketMarkPrice,
  selectCurrentPerpsMarket,
  selectSpreadPercentage,
} from '../orderbook/selectors'
import {
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
} from './common'
import { selectScaleLimitOrders } from './scale'

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

    return orderType === OrderType.Market && slippage > 5
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

export const selectShowPriceProtectionWarning = createSelector(
  [selectShowLimitPriceProtectionWarning, selectShowScalePriceProtectionWarning],
  createTracking(
    'selectShowPriceProtectionWarning',
    (showLimitPriceProtectionWarning, showScalePriceProtectionWarning) => {
      if (isTestingEnvironment()) {
        return false
      }

      return showLimitPriceProtectionWarning || showScalePriceProtectionWarning
    },
  ),
)

export const selectShowOppositeSidePositionWarning = createSelector(
  [
    selectOrderType,
    selectIsShort,
    selectReduceOnly,
    selectCurrentMarketPosition,
    selectDerivedSliderValue,
    selectBaseAmount,
  ],
  createTracking(
    'selectShowOppositeSidePositionWarning',
    (orderType, isShort, reduceOnly, position, sliderValue, baseAmount) => {
      if (isTestingEnvironment()) {
        return false
      }

      if (orderType !== OrderType.Market && orderType !== OrderType.Twap) {
        return false
      }

      if (reduceOnly) {
        return false
      }

      const positionSize = position?.position ?? 0
      if (positionSize === 0) {
        return false
      }

      const isOppositeSide = (position?.sign === 1) === isShort
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
