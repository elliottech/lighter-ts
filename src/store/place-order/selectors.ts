import { OrderDirections } from '../../constants/shared'
import { MarginMode } from '../../types/MarginMode'
import { OrderType } from '../../types/order'
import { isMarketIsolatedOnly } from '../../utils/marketFlags'
import { selectCurrentMarketPosition } from '../accounts/selectors'
import {
  selectCurrentMarket,
  selectIsCurrentMarketReduceOnly,
  selectIsCurrentMarketSpot,
  selectIsOpenInterestLimitReached,
} from '../orderbook/selectors'
import {
  selectDirection,
  selectDisplayedForm,
  selectOrderType,
  selectReduceOnlyRaw,
} from '../params/selectors'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import type { PlaceOrderSlice } from './createPlaceOrderSlice'

export const selectTriggerPriceInputValue = (state: PlaceOrderSlice) => state.triggerPriceInputValue

export const selectTimeInForce = (state: PlaceOrderSlice) => state.timeInForce

export const selectTimeInForceValue = (state: PlaceOrderSlice) => state.timeInForceValue

export const selectTimeInForceUnit = (state: PlaceOrderSlice) => state.timeInForceUnit

export const selectRuntimeHours = (state: PlaceOrderSlice) => state.runtimeHours

export const selectRuntimeMinutes = (state: PlaceOrderSlice) => state.runtimeMinutes

export const selectStopLoss = (state: PlaceOrderSlice) => state.stopLoss

export const selectTakeProfit = (state: PlaceOrderSlice) => state.takeProfit

export const selectScaleInputValue = (state: PlaceOrderSlice) => state.scale

export const selectIsInputLocked = (state: PlaceOrderSlice) => state.isInputLocked

export const selectIsTwap = createSelector(
  [selectOrderType],
  createTracking('selectIsTwap', (orderType) => orderType === OrderType.Twap),
)

export const selectIsScale = createSelector(
  [selectOrderType],
  createTracking('selectIsScale', (orderType) => orderType === OrderType.Scale),
)

export const selectIsShort = createSelector(
  [selectDirection],
  createTracking('selectIsShort', (direction) => direction === OrderDirections.Short),
)

export const selectIsLimit = createSelector(
  [selectOrderType],
  createTracking('selectIsLimit', (orderType) => orderType === OrderType.Limit),
)

export const selectIsConditional = createSelector(
  [selectOrderType],
  createTracking('selectIsConditional', (orderType) => orderType === OrderType.Conditional),
)

export const selectReduceOnly = createSelector(
  [
    selectReduceOnlyRaw,
    selectDisplayedForm,
    selectIsLimit,
    selectIsOpenInterestLimitReached,
    selectIsCurrentMarketReduceOnly,
    selectIsCurrentMarketSpot,
    selectCurrentMarket,
    selectCurrentMarketPosition,
  ],
  createTracking(
    'selectReduceOnly',
    (
      reduceOnly,
      displayedForm,
      isLimit,
      isOpenInterestLimitReached,
      isCurrentMarketReduceOnly,
      isCurrentMarketSpot,
      currentMarket,
      position,
    ) =>
      !isCurrentMarketSpot &&
      (reduceOnly ||
        displayedForm.type === 'closePosition' ||
        isCurrentMarketReduceOnly ||
        (isOpenInterestLimitReached && !isLimit) ||
        (isMarketIsolatedOnly(currentMarket) &&
          !!position?.position &&
          position.margin_mode === MarginMode.CROSS)),
  ),
)
