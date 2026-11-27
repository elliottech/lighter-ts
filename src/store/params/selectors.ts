import { OrderDirections } from '../../constants/shared'
import { type OrderPlacementInput, OrderType } from '../../types/order'
import { isMarketSpot } from '../../utils/common'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import { selectOrderBookMetas } from '../orderbook/metadataSelectors'
import type { PlaceOrderSlice } from '../place-order/createPlaceOrderSlice'
import type { TimeInForce } from '../place-order/utils'
import type { PreferencesSlice } from '../preferences/createPreferencesSlice'
import type { TokensSlice } from '../tokens/createTokensSlice'
import type { RouteType } from '../types'
import type { UserSlice } from '../user/createUserSlice'

export const selectMarketId = <T, ParamsT extends { marketId: number }>(
  _state: T,
  params: ParamsT,
) => params.marketId

export const selectOrderId = <T, ParamsT extends { orderId: string }>(_state: T, params: ParamsT) =>
  params.orderId

export type TransferableMarginParams = {
  amount: number
  assetId: number
  routeType: RouteType
}

export const selectTransferableAmount = <T>(_state: T, params: TransferableMarginParams) =>
  params.amount
export const selectTransferRouteType = <T>(_state: T, params: TransferableMarginParams) =>
  params.routeType

export type OptionalAccountIndex = { accountIndex?: number }
export function selectAccountIndex<T extends UserSlice, ParamsT extends OptionalAccountIndex>(
  state: T,
  params?: ParamsT,
) {
  return params?.accountIndex ?? state.accountIndex
}

export type OptionalDirection = { direction?: OrderDirections }
export function selectDirection<T extends PreferencesSlice, ParamsT extends OptionalDirection>(
  state: T,
  params?: ParamsT,
): OrderDirections {
  return params?.direction ?? state.preferences.orderDirection
}

export type OptionalOrderType = { orderType?: OrderType }
export function selectOrderType<
  T extends PreferencesSlice & PlaceOrderSlice & OrderBookSlice & TokensSlice,
  ParamsT extends OptionalOrderType & OptionalDisplayedForm,
>(state: T, params?: ParamsT): OrderType {
  if (params?.orderType !== undefined) return params.orderType
  if (selectDisplayedForm(state, params).type === 'closePosition') {
    return state.preferences.closePositionOrderType
  }

  const preferredType = state.preferences.orderType
  if (preferredType !== OrderType.Conditional) return preferredType

  const market = selectOrderBookMetas(state)[state.currentMarketId]
  const isSpot = !!market && isMarketSpot(market)
  return isSpot ? OrderType.Market : preferredType
}

export type OptionalIsAdvancedTWAP = {
  isAdvancedTWAP?: boolean
}
export function selectIsAdvancedTWAP<T, ParamsT extends OptionalIsAdvancedTWAP>(
  _state: T,
  params?: ParamsT,
): boolean {
  return params?.isAdvancedTWAP ?? false
}

export type OptionalTimeInForce = { timeInForce?: TimeInForce }
export function selectTimeInForce<T extends PlaceOrderSlice, ParamsT extends OptionalTimeInForce>(
  state: T,
  params?: ParamsT,
): TimeInForce {
  return params?.timeInForce ?? state.timeInForce
}

type OptionalReduceOnly = { reduceOnly?: boolean }
export function selectReduceOnlyRaw<T extends PlaceOrderSlice, ParamsT extends OptionalReduceOnly>(
  state: T,
  params?: ParamsT,
) {
  return params?.reduceOnly ?? state.reduceOnly
}

type OptionalDisplayedForm = { displayedForm?: PlaceOrderSlice['displayedForm'] }
export function selectDisplayedForm<
  T extends PlaceOrderSlice,
  ParamsT extends OptionalDisplayedForm,
>(state: T, params?: ParamsT) {
  return params?.displayedForm ?? state.displayedForm
}

export type OptionalPinnedInput = { pinnedInput?: OrderPlacementInput }
export function selectPinnedInput<T extends PreferencesSlice, ParamsT extends OptionalPinnedInput>(
  state: T,
  params?: ParamsT,
): OrderPlacementInput {
  return params?.pinnedInput ?? state.preferences.pinnedInput
}

export type OptionalPinnedValueInputValue = { pinnedValueInputValue?: string }
export function selectPinnedValueInputValue<
  T extends PlaceOrderSlice,
  ParamsT extends OptionalPinnedValueInputValue,
>(state: T, params?: ParamsT): string {
  return params?.pinnedValueInputValue ?? state.pinnedValueInputValue
}

export type OptionalLimitPrice = { limitPriceInputValue?: string }
export function selectLimitPriceInputValue<
  T extends PlaceOrderSlice,
  ParamsT extends OptionalLimitPrice,
>(state: T, params?: ParamsT): string {
  return params?.limitPriceInputValue ?? state.limitPriceInputValue
}

export type OptionalAssetId = { assetId?: number }
export const selectAssetId = <
  T extends OrderBookSlice & PreferencesSlice,
  ParamsT extends OptionalAssetId & OptionalDirection,
>(
  state: T,
  params?: ParamsT,
) => {
  if (typeof params?.assetId === 'number') {
    return params?.assetId
  }
  const currentMarketId = state.currentMarketId
  const currentMarket =
    state.spotOrderBookMetas[currentMarketId] ?? state.perpsOrderBookMetas[currentMarketId]

  if (!currentMarket) return -1

  return selectDirection(state, params) === OrderDirections.Long
    ? currentMarket.quote_asset_id
    : currentMarket.base_asset_id
}
