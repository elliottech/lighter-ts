import type { OrderDirections } from '../../constants/shared'
import { marginFractionToLeverage } from '../../formulas/common'
import { getSLTPInfo } from '../../formulas/sltp'
import {
  getInvalidSLTPPriceText,
  type InvalidSLTPPriceText,
} from '../../formulas/sltpTriggerValidation'
import { OrderType } from '../../types/order'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import { selectCurrentMarket, selectCurrentMarketMarkPrice } from '../orderbook/selectors'
import {
  selectDisplayedForm,
  selectOrderType,
  type OptionalDirection,
  type OptionalLimitPrice,
  type OptionalOrderType,
  type OptionalPinnedInput,
  type OptionalPinnedValueInputValue,
} from '../params/selectors'
import type { PlaceOrderSlice } from '../place-order/createPlaceOrderSlice'
import { selectIsLimit, selectStopLoss, selectTakeProfit } from '../place-order/selectors'
import type { PreferencesSlice } from '../preferences/createPreferencesSlice'
import { selectConditionalLimitPrefill } from '../preferences/selectors'
import type { TokensSlice } from '../tokens/createTokensSlice'
import type { UserSlice } from '../user/createUserSlice'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import {
  selectBaseAmount,
  selectCurrentMarketInitialMarginFraction,
  selectEstPrice,
  selectLimitPrice,
  selectPositionAwareIsShort,
} from './common'
import { selectUpdatedLiqPrice } from './updatedStats'

export const selectStopLossInfo: (
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
) => ReturnType<typeof getSLTPInfo> = createSelector(
  [
    selectCurrentMarketInitialMarginFraction,
    selectPositionAwareIsShort,
    selectStopLoss,
    selectEstPrice,
    selectBaseAmount,
    selectCurrentMarket,
  ],
  createTracking(
    'selectStopLossInfo',
    (initialMarginFraction, isShort, stopLoss, estPrice, baseAmount, currentMarket) =>
      getSLTPInfo({
        orderSize: baseAmount,
        sltp: stopLoss,
        leverage: marginFractionToLeverage(initialMarginFraction),
        isShort,
        referencePrice: estPrice,
        market: currentMarket,
        isSL: true,
      }),
  ),
)

export const selectTakeProfitInfo: (
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
) => ReturnType<typeof getSLTPInfo> = createSelector(
  [
    selectCurrentMarketInitialMarginFraction,
    selectPositionAwareIsShort,
    selectTakeProfit,
    selectEstPrice,
    selectBaseAmount,
    selectCurrentMarket,
  ],
  createTracking(
    'selectTakeProfitInfo',
    (initialMarginFraction, isShort, takeProfit, estPrice, baseAmount, currentMarket) =>
      getSLTPInfo({
        orderSize: baseAmount,
        sltp: takeProfit,
        leverage: marginFractionToLeverage(initialMarginFraction),
        isShort,
        referencePrice: estPrice,
        market: currentMarket,
        isSL: false,
      }),
  ),
)

export const selectInvalidStopLossPriceText: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: { direction?: OrderDirections },
) => InvalidSLTPPriceText = createSelector(
  [
    selectPositionAwareIsShort,
    selectIsLimit,
    selectEstPrice,
    selectStopLossInfo,
    selectCurrentMarketMarkPrice,
    selectCurrentMarket,
    selectUpdatedLiqPrice,
  ],
  createTracking(
    'selectInvalidStopLossPriceText',
    (
      isShort,
      isLimit,
      estPrice,
      stopLossInfo,
      markPrice,
      currentMarket,
      liqPrice,
    ): InvalidSLTPPriceText =>
      getInvalidSLTPPriceText({
        isSL: true,
        isShort,
        isLimit,
        estPrice,
        triggerPrice: stopLossInfo.triggerPrice,
        triggerPriceInputValue: stopLossInfo.triggerPriceInputValue,
        markPrice,
        displayPriceDecimals: currentMarket.display_price_decimals,
        liquidationPrice: liqPrice ?? 0,
      }),
  ),
)

export const selectInvalidTakeProfitPriceText: (
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
) => InvalidSLTPPriceText = createSelector(
  [
    selectPositionAwareIsShort,
    selectIsLimit,
    selectEstPrice,
    selectTakeProfitInfo,
    selectCurrentMarketMarkPrice,
    selectCurrentMarket,
  ],
  createTracking(
    'selectInvalidTakeProfitPriceText',
    (isShort, isLimit, estPrice, takeProfitInfo, markPrice, currentMarket) =>
      getInvalidSLTPPriceText({
        isSL: false,
        isShort,
        isLimit,
        estPrice,
        triggerPrice: takeProfitInfo.triggerPrice,
        triggerPriceInputValue: takeProfitInfo.triggerPriceInputValue,
        markPrice,
        displayPriceDecimals: currentMarket.display_price_decimals,
        liquidationPrice: 0,
      }),
  ),
)

export const selectIsSLTPSlippageRelevant: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
) => boolean = createSelector(
  [
    selectDisplayedForm,
    selectOrderType,
    selectStopLossInfo,
    selectTakeProfitInfo,
    selectLimitPrice,
    selectConditionalLimitPrefill,
  ],
  createTracking(
    'selectIsSLTPSlippageRelevant',
    (
      displayedForm,
      orderType,
      stopLossInfo,
      takeProfitInfo,
      limitPrice,
      conditionalLimitPrefill,
    ) => {
      if (displayedForm.type !== 'placeOrder') {
        return true
      }

      switch (orderType) {
        case OrderType.Market:
        case OrderType.Limit:
          return [stopLossInfo, takeProfitInfo].some(
            (info) => !!info.triggerPrice && (conditionalLimitPrefill || !info.limitPrice),
          )
        case OrderType.Conditional:
          return conditionalLimitPrefill || !limitPrice
        case OrderType.Twap:
        case OrderType.Scale:
          return false
      }
    },
  ),
)
