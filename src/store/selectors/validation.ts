import {
  AccountAccountTradingModeEnum,
  AccountPositionSignEnum,
  OrderTimeInForceEnum,
  OrderTypeEnum,
} from 'zklighter-perps'
import type { OrderDirections } from '../../constants/shared'
import {
  computeNotEnoughMargin,
  computeShouldShowLimitPriceWarning,
  computeTooMuchSlippage,
  computeWorstExecutionPrice,
} from '../../formulas/orderBook'
import { doesOrderUseMargin } from '../../formulas/orderMargin'
import { OrderType, type OrderPlacementInput } from '../../types/order'
import { isMarketSpot } from '../../utils/common'
import { getOrderAmountErrorText } from '../../utils/getOrderAmountErrorText'
import { getOrderAmountErrorType } from '../../utils/getOrderAmountErrorType'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import {
  selectAccountTradingMode,
  selectActiveOrders,
  selectCurrentMarketPosition,
  selectRawAssetBalances,
} from '../accounts/selectors'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import { selectOrderBookMetas } from '../orderbook/metadataSelectors'
import {
  selectCurrentMarket,
  selectCurrentMarketId,
  selectCurrentMarketMarkPrice,
  selectIsCurrentMarketSpot,
  selectOrderBook,
  USDC_ASSET_ID,
} from '../orderbook/selectors'
import {
  selectAssetId,
  selectOrderType,
  selectPinnedValueInputValue,
  selectTransferableAmount,
  selectTransferRouteType,
  type OptionalAccountIndex,
  type OptionalDirection,
  type OptionalLimitPrice,
  type OptionalOrderType,
  type OptionalPinnedInput,
  type OptionalPinnedValueInputValue,
  selectIsAdvancedTWAP,
  type TransferableMarginParams,
} from '../params/selectors'
import type { PlaceOrderSlice } from '../place-order/createPlaceOrderSlice'
import { getOrderPriceFromParams, getOrderType, getOrderTypeFromTx } from '../place-order/utils'
import {
  selectIsScale,
  selectIsShort,
  selectReduceOnly,
  selectTimeInForce,
} from '../place-order/selectors'
import type { PreferencesSlice } from '../preferences/createPreferencesSlice'
import { selectMaxSlippage, selectMaxSLTPSlippage } from '../preferences/selectors'
import type { TokensSlice } from '../tokens/createTokensSlice'
import { RouteType } from '../types'
import type { UserSlice } from '../user/createUserSlice'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import {
  selectAvailableBalanceToTransfer,
  selectBaseAmount,
  selectClassicAvailablePerpsUSDCToTransfer,
  selectHasMarginReservedByActiveOrders,
  selectLimitPrice,
  selectLiqPrice,
  selectMarketOrderPrice,
  selectPositionAwareIsShort,
  selectSliderMax,
  selectTWAPOrderPrice,
  selectTriggerPrice,
} from './common'
import { selectSlippage } from './placeOrder'
import { selectScaleLimitOrders } from './scale'

const selectOrderValidationPrice = createSelector(
  [
    selectOrderType,
    selectLimitPrice,
    selectMarketOrderPrice,
    selectTWAPOrderPrice,
    selectMaxSLTPSlippage,
    selectPositionAwareIsShort,
    selectTriggerPrice,
  ],
  createTracking(
    'selectOrderValidationPrice',
    (
      orderType,
      limitPrice,
      marketOrderPrice,
      twapOrderPrice,
      maxSLTPSlippage,
      isShort,
      triggerPrice,
    ) =>
      getOrderPriceFromParams(
        orderType,
        limitPrice,
        marketOrderPrice,
        twapOrderPrice,
        computeWorstExecutionPrice(maxSLTPSlippage, isShort, triggerPrice),
      ),
  ),
)

const selectOrderTypeEnum = createSelector(
  [
    selectOrderType,
    selectTriggerPrice,
    selectLimitPrice,
    selectCurrentMarketMarkPrice,
    selectPositionAwareIsShort,
  ],
  createTracking('selectOrderTypeEnum', (orderType, triggerPrice, limitPrice, markPrice, isShort) =>
    getOrderTypeFromTx(getOrderType(orderType, triggerPrice, limitPrice, markPrice ?? 0, isShort)),
  ),
)

export const selectIsSourceAmountZero = createSelector(
  [selectPinnedValueInputValue],
  createTracking(
    'selectIsSourceAmountZero',
    (pinnedValueInputValue) => Number(pinnedValueInputValue) === 0,
  ),
)

export const selectTooMuchSlippage = createSelector(
  [selectOrderType, selectSlippage, selectMaxSlippage],
  createTracking('selectTooMuchSlippage', computeTooMuchSlippage),
)

export const selectNotEnoughMargin: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: {
    direction?: OrderDirections
    orderType?: OrderType
    pinnedInput?: OrderPlacementInput
    pinnedValueInputValue?: string
    limitPriceInputValue?: string
  },
) => boolean = createSelector(
  [selectSliderMax, selectBaseAmount, selectCurrentMarket],
  createTracking('selectNotEnoughMargin', computeNotEnoughMargin),
)

const selectMarginUsingActivePerpsOrders = createSelector(
  [selectActiveOrders, selectOrderBookMetas],
  createTracking('selectMarginUsingActivePerpsOrders', (activeOrders, orderBookMetas) =>
    Object.entries(activeOrders).flatMap(([marketId, orders]) => {
      const market = orderBookMetas[marketId]
      return market === undefined || isMarketSpot(market) ? [] : orders.filter(doesOrderUseMargin)
    }),
  ),
)

const selectHasMarginTiedUp = createSelector(
  [
    selectMarginUsingActivePerpsOrders,
    selectCurrentMarketId,
    selectPositionAwareIsShort,
    selectIsCurrentMarketSpot,
    selectCurrentMarket,
    selectRawAssetBalances,
    selectAccountTradingMode,
  ],
  createTracking(
    'selectHasMarginTiedUp',
    (
      marginUsingActivePerpsOrders,
      currentMarketId,
      isShort,
      isCurrentMarketSpot,
      currentMarket,
      assetBalances,
      accountTradingMode,
    ) => {
      if (isCurrentMarketSpot) {
        const assetId = isShort ? currentMarket.base_asset_id : currentMarket.quote_asset_id
        return (assetBalances?.[assetId]?.locked_balance ?? 0) > 0
      }

      const hasMarginUsingOrders = marginUsingActivePerpsOrders.some(
        (order) => order.market_index !== currentMarketId || order.is_ask === isShort,
      )

      return (
        hasMarginUsingOrders ||
        (accountTradingMode === AccountAccountTradingModeEnum.Unified &&
          (assetBalances?.[USDC_ASSET_ID]?.locked_balance ?? 0) > 0)
      )
    },
  ),
)

export const selectNotEnoughMarginFromRestingOrders: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: OptionalOrderType &
    OptionalDirection &
    OptionalPinnedInput &
    OptionalPinnedValueInputValue &
    OptionalLimitPrice,
) => boolean = createSelector(
  [selectNotEnoughMargin, selectHasMarginTiedUp, selectOrderType],
  createTracking(
    'selectNotEnoughMarginFromRestingOrders',
    (notEnoughMargin, hasMarginTiedUp, orderType) =>
      notEnoughMargin && hasMarginTiedUp && orderType !== OrderType.Market,
  ),
)

export const selectNotEnoughTransferableMargin: (
  state: AccountsSlice & OrderBookSlice & PreferencesSlice & TokensSlice & UserSlice,
  params: TransferableMarginParams,
) => boolean = createSelector(
  [
    selectHasMarginReservedByActiveOrders,
    selectAccountTradingMode,
    selectAvailableBalanceToTransfer,
    selectClassicAvailablePerpsUSDCToTransfer,
    selectRawAssetBalances,
    selectAssetId,
    selectTransferRouteType,
    selectTransferableAmount,
  ],
  createTracking(
    'selectNotEnoughTransferableMargin',
    (
      hasMarginReservedByActiveOrders,
      accountTradingMode,
      availableBalanceToTransfer,
      classicAvailablePerpsUSDCToTransfer,
      assetBalances,
      assetId,
      routeType,
      amount,
    ) => {
      const selectedAssetMarginMode = assetBalances?.[assetId]?.margin_mode
      const usesMarginBalance =
        accountTradingMode === AccountAccountTradingModeEnum.Unified
          ? selectedAssetMarginMode !== 'disabled'
          : assetId === USDC_ASSET_ID && routeType === RouteType.Perps
      const availableBalance =
        accountTradingMode === AccountAccountTradingModeEnum.Unified
          ? availableBalanceToTransfer
          : classicAvailablePerpsUSDCToTransfer

      return (
        usesMarginBalance &&
        hasMarginReservedByActiveOrders &&
        availableBalance !== null &&
        amount > availableBalance
      )
    },
  ),
)

export type PlaceOrderSizeErrorText =
  | {
      key: 'maximum_order_size_warning'
      values: { amount: string }
    }
  | {
      key: 'maximum_order_size_warning_scale'
      values: { maxValue: string }
    }
  | {
      key: 'order_size_zero_warning'
    }
  | {
      key: 'min_order_size_warning'
      values: { minValue: string; minSize: string }
    }
  | {
      key: 'minimum_order_size_warning_scale'
      values: { minValue: string; minSize: string }
    }
  | null

export const selectPlaceOrderSizeErrorText = createSelector(
  [
    selectIsAdvancedTWAP,
    selectIsScale,
    selectScaleLimitOrders,
    selectTimeInForce,
    selectOrderTypeEnum,
    selectBaseAmount,
    selectOrderValidationPrice,
    selectPinnedValueInputValue,
    selectCurrentMarket,
  ],
  createTracking(
    'selectPlaceOrderSizeErrorText',
    (
      isAdvancedTWAP,
      isScale,
      scaleOrders,
      timeInForce,
      orderTypeEnum,
      baseAmount,
      orderPrice,
      pinnedValueInputValue,
      currentMarket,
    ): PlaceOrderSizeErrorText => {
      if (Number(pinnedValueInputValue) === 0 || isAdvancedTWAP) return null

      const timeInForceEnum =
        timeInForce === 'ioc' && orderTypeEnum === OrderTypeEnum.Limit
          ? OrderTimeInForceEnum.ImmediateOrCancel
          : OrderTimeInForceEnum.GoodTillTime
      const orderAmountErrorType = (
        isScale
          ? scaleOrders.map((order) =>
              getOrderAmountErrorType(
                order.size,
                order.price,
                currentMarket,
                OrderTypeEnum.Limit,
                timeInForceEnum,
              ),
            )
          : [
              getOrderAmountErrorType(
                baseAmount,
                orderPrice,
                currentMarket,
                orderTypeEnum,
                timeInForceEnum,
              ),
            ]
      ).find((error) => error !== null)

      if (orderAmountErrorType) {
        return getOrderAmountErrorText(orderAmountErrorType, currentMarket, isScale)
      }

      if (baseAmount === 0) {
        return { key: 'order_size_zero_warning' }
      }

      return null
    },
  ),
)

export const selectIsPlaceOrderSizeInvalid = createSelector(
  [selectIsSourceAmountZero, selectPlaceOrderSizeErrorText],
  createTracking(
    'selectIsPlaceOrderSizeInvalid',
    (isSourceAmountZero, sizeErrorText) => isSourceAmountZero || !!sizeErrorText,
  ),
)

export const selectShouldShowLimitPriceWarning = createSelector(
  [
    selectOrderType,
    selectTimeInForce,
    selectPositionAwareIsShort,
    selectLimitPrice,
    selectBaseAmount,
    selectOrderBook,
  ],
  createTracking('selectShouldShowLimitPriceWarning', computeShouldShowLimitPriceWarning),
)

export const selectShouldShowScalePriceWarning: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: OptionalOrderType &
    OptionalDirection &
    OptionalAccountIndex &
    OptionalPinnedInput &
    OptionalPinnedValueInputValue &
    OptionalLimitPrice,
) => boolean = createSelector(
  [
    selectOrderType,
    selectTimeInForce,
    selectPositionAwareIsShort,
    selectScaleLimitOrders,
    selectBaseAmount,
    selectOrderBook,
  ],
  createTracking(
    'selectShouldShowLimitPriceWarning',
    (orderType, timeInForce, isShort, orders, baseAmount, { bids, asks }) => {
      if (
        orderType !== OrderType.Scale ||
        timeInForce === 'ioc' ||
        !baseAmount ||
        bids.length === 0 ||
        asks.length === 0 ||
        orders.length === 0
      ) {
        return false
      }

      return isShort ? orders[0]!.price <= bids[0]!.price : orders[0]!.price >= asks[0]!.price
    },
  ),
)

export const selectIsReduceOnlyInvalid = createSelector(
  [selectReduceOnly, selectPositionAwareIsShort, selectBaseAmount, selectCurrentMarketPosition],
  createTracking('selectIsReduceOnlyInvalid', (reduceOnly, isShort, baseAmount, position) => {
    if (!reduceOnly) {
      return false
    }

    if (!position?.position || (position.sign === AccountPositionSignEnum.Short) === isShort) {
      return true
    }

    return position.position < baseAmount
  }),
)

export const selectIsSLTriggerPriceBeyondLiquidation = createSelector(
  [
    selectOrderType,
    selectReduceOnly,
    selectCurrentMarketPosition,
    selectLiqPrice,
    selectTriggerPrice,
    selectCurrentMarketMarkPrice,
    selectIsShort,
  ],
  createTracking(
    'selectIsSLTriggerPriceBeyondLiquidation',
    (orderType, reduceOnly, position, liquidationPrice, triggerPrice, markPrice, isShort) => {
      if (
        !reduceOnly ||
        !triggerPrice ||
        !liquidationPrice ||
        !markPrice ||
        orderType !== OrderType.Conditional
      ) {
        return false
      }

      // Hide when the reduce-only warning is shown (no position / wrong direction)
      const positionSize = position?.position ?? 0
      const isSameDirection = (position?.sign === AccountPositionSignEnum.Long) === !isShort
      if (positionSize === 0 || isSameDirection) {
        return false
      }

      if (isShort) {
        return triggerPrice < markPrice && triggerPrice < liquidationPrice
      }

      return triggerPrice > markPrice && triggerPrice > liquidationPrice
    },
  ),
)
