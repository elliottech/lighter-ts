import type { OrderDirections } from '../../constants/shared'
import { computeTooMuchSlippage } from '../../formulas/orderBook'
import { doesOrderUseMargin } from '../../formulas/orderMargin'
import { AccountTradingMode } from '../../types/accountTradingMode'
import type { OrderBookDetail } from '../../types/compatibility'
import { OrderType, type OrderPlacementInput } from '../../types/order'
import { isMarketSpot } from '../../utils/common'
import { floorNumber } from '../../utils/precision'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import {
  selectAccountTradingMode,
  selectActiveOrders,
  selectCurrentMarketPosition,
  selectRawAssetBalances,
} from '../accounts/selectors'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import {
  selectCurrentMarket,
  selectCurrentMarketId,
  selectCurrentMarketMarkPrice,
  selectIsCurrentMarketSpot,
  selectOrderBook,
  selectOrderBookMetas,
  USDC_ASSET_ID,
} from '../orderbook/selectors'
import {
  selectAssetId,
  selectOrderType,
  selectTransferableAmount,
  selectTransferRouteType,
  type OptionalAccountIndex,
  type OptionalDirection,
  type OptionalLimitPrice,
  type OptionalOrderType,
  type OptionalPinnedInput,
  type OptionalPinnedValueInputValue,
  type TransferableMarginParams,
} from '../params/selectors'
import type { PlaceOrderSlice } from '../place-order/createPlaceOrderSlice'
import {
  selectIsScale,
  selectIsShort,
  selectReduceOnly,
  selectTimeInForce,
} from '../place-order/selectors'
import type { PreferencesSlice } from '../preferences/createPreferencesSlice'
import { selectMaxSlippage } from '../preferences/selectors'
import type { TokensSlice } from '../tokens/createTokensSlice'
import { RouteType } from '../types'
import type { UserSlice } from '../user/createUserSlice'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import {
  selectAvailableBalanceToTransfer,
  selectAvailableLiquidity,
  selectBaseAmount,
  selectClassicAvailablePerpsUSDCToTransfer,
  selectHasMarginReservedByActiveOrders,
  selectLimitPrice,
  selectLiqPrice,
  selectPositionAwareIsShort,
  selectQuoteAmount,
  selectSliderMax,
  selectTriggerPrice,
} from './common'
import { selectSlippage } from './placeOrder'
import { selectScaleLimitOrders } from './scale'

const validateBaseAmount = (baseAmount: number, currentMarket: OrderBookDetail) =>
  baseAmount >= Number(currentMarket.min_base_amount)

const validateQuoteAmount = (quoteAmount: number, currentMarket: OrderBookDetail) =>
  quoteAmount >= Number(currentMarket.min_quote_amount)

const validateQuoteAmountExceedsMax = (quoteAmount: number, currentMarket: OrderBookDetail) =>
  quoteAmount > Number(currentMarket.order_quote_limit)

export const selectIsBaseAmountValid = createSelector(
  [selectBaseAmount, selectCurrentMarket],
  createTracking('selectIsBaseAmountValid', validateBaseAmount),
)

export const selectIsQuoteAmountValid = createSelector(
  [selectQuoteAmount, selectCurrentMarket],
  createTracking('selectIsQuoteAmountValid', validateQuoteAmount),
)

export const selectIsQuoteAmountExceedsMax = createSelector(
  [selectQuoteAmount, selectCurrentMarket],
  createTracking('selectIsQuoteAmountExceedsMax', validateQuoteAmountExceedsMax),
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
  [
    selectOrderType,
    selectAvailableLiquidity,
    selectSliderMax,
    selectBaseAmount,
    selectCurrentMarket,
  ],
  createTracking(
    'selectNotEnoughMargin',
    (orderType, availableLiquidity, sliderMax, baseAmount, currentMarket) => {
      // If a user can buy everything there is in the orderBook he shouldn't get this error
      if (orderType === OrderType.Market && availableLiquidity === sliderMax) {
        return false
      }

      return floorNumber(baseAmount - sliderMax, currentMarket.size_decimals) > 0
    },
  ),
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
        (accountTradingMode === AccountTradingMode.UNIFIED &&
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
        accountTradingMode === AccountTradingMode.UNIFIED
          ? selectedAssetMarginMode !== 'disabled'
          : assetId === USDC_ASSET_ID && routeType === RouteType.Perps
      const availableBalance =
        accountTradingMode === AccountTradingMode.UNIFIED
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

export const selectIsScaleValid = createSelector(
  [selectIsScale, selectScaleLimitOrders, selectCurrentMarket],
  createTracking(
    'selectIsScaleValid',
    (isScale, orders, currentMarket) =>
      !isScale ||
      orders.every(
        (order) =>
          validateBaseAmount(order.size, currentMarket) &&
          validateQuoteAmount(order.size * order.price, currentMarket),
      ),
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
  createTracking(
    'selectShouldShowLimitPriceWarning',
    (orderType, timeInForce, isShort, limitPrice, baseAmount, { bids, asks }) => {
      if (
        orderType !== OrderType.Limit ||
        timeInForce === 'ioc' ||
        !baseAmount ||
        bids.length === 0 ||
        asks.length === 0
      ) {
        return false
      }

      return isShort ? limitPrice <= bids[0]!.price : limitPrice >= asks[0]!.price
    },
  ),
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

export const selectIsReduceOnlyValid = createSelector(
  [selectReduceOnly, selectPositionAwareIsShort, selectBaseAmount, selectCurrentMarketPosition],
  createTracking('selectIsReduceOnlyValid', (reduceOnly, isShort, baseAmount, position) => {
    if (!reduceOnly) {
      return true
    }

    if (!position?.position || (position.sign === -1) === isShort) {
      return false
    }

    return position.position >= baseAmount
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
      const isSameDirection = (position?.sign === 1) === !isShort
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
