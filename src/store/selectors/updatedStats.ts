import {
  computePositionsLiqPrices,
  computeRealizedPnl,
  computeTotalAccountLiquidationValue,
  computeTotalMaintenanceMarginReq,
  computeTotalUnrealizedPnl,
} from '../../formulas/common'
import {
  computePositionDelta,
  computeUpdatedCrossCollateral,
  computeUpdatedPositions,
} from '../../formulas/updatedStats'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import {
  filterIsolatedPositions,
  selectCurrentMarketPosition,
  selectRawPositions,
} from '../accounts/selectors'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import {
  selectCurrentMarket,
  selectCurrentMarketId,
  selectCurrentMarketMarkPrice,
  selectPerpsMarketsStats,
  selectPerpsOrderBookMetas,
} from '../orderbook/selectors'
import type {
  OptionalAccountIndex,
  OptionalAssetId,
  OptionalDirection,
  OptionalLimitPrice,
  OptionalOrderType,
  OptionalPinnedInput,
  OptionalPinnedValueInputValue,
} from '../params/selectors'
import type { PlaceOrderSlice } from '../place-order/createPlaceOrderSlice'
import type { PreferencesSlice } from '../preferences/createPreferencesSlice'
import type { TokensSlice } from '../tokens/createTokensSlice'
import type { Position } from '../types'
import type { UserSlice } from '../user/createUserSlice'
import { createDeepEqualSelector } from '../utils/createDeepEqualSelector'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import {
  extractRelevantMarkPrices,
  selectBaseAmount,
  selectCurrentMarketInitialMarginFraction,
  selectEstPrice,
  selectLiqCollateral,
  selectPositionAwareIsShort,
} from './common'
import { selectCurrentMarketFees } from './fees'

const selectPositionDelta = createSelector(
  [
    selectCurrentMarketPosition,
    selectCurrentMarketInitialMarginFraction,
    selectCurrentMarket,
    selectPositionAwareIsShort,
    selectBaseAmount,
    selectEstPrice,
  ],
  createTracking('selectPositionDelta', computePositionDelta),
)

const selectUpdatedPositions = createSelector(
  [selectRawPositions, selectPositionDelta, selectCurrentMarketId],
  createTracking('selectUpdatedPositions', computeUpdatedPositions),
)
const selectUpdatedCrossPositions = createSelector(
  [selectUpdatedPositions],
  createTracking('selectUpdatedCrossPositions', filterIsolatedPositions),
)

export const selectUpdatedPosition: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: OptionalAccountIndex &
    OptionalDirection &
    OptionalOrderType &
    OptionalPinnedInput &
    OptionalPinnedValueInputValue &
    OptionalLimitPrice &
    OptionalAssetId,
) => Position | undefined = createSelector(
  [selectUpdatedPositions, selectCurrentMarketId],
  createTracking(
    'selectUpdatedPosition',
    (positions, marketId): Position | undefined => positions[marketId],
  ),
)

const selectUpdatedPositionsMarkPrices = createDeepEqualSelector(
  [selectUpdatedPositions, selectPerpsMarketsStats],
  createTracking('selectUpdatedPositionsMarkPrices', (positions, perpsMarketsStats) =>
    extractRelevantMarkPrices(
      perpsMarketsStats,
      ({ market_id }) => !!positions[market_id]?.position,
    ),
  ),
)

const selectUpdatedCrossUnrealizedPnl = createSelector(
  [selectUpdatedPositionsMarkPrices, selectUpdatedCrossPositions],
  createTracking('selectUpdatedCrossUnrealizedPnl', computeTotalUnrealizedPnl),
)
const selectRealizedPnl: (
  state: AccountsSlice &
    OrderBookSlice &
    PlaceOrderSlice &
    PreferencesSlice &
    TokensSlice &
    UserSlice,
  params?: OptionalAccountIndex &
    OptionalDirection &
    OptionalOrderType &
    OptionalPinnedInput &
    OptionalPinnedValueInputValue &
    OptionalLimitPrice &
    OptionalAssetId,
) => number = createSelector(
  [selectPositionDelta, selectCurrentMarketPosition],
  createTracking('selectRealizedPnl', computeRealizedPnl),
)

const selectUpdatedLiqCollateral = createSelector(
  [
    selectLiqCollateral,
    selectRealizedPnl,
    selectCurrentMarketMarkPrice,
    selectPositionDelta,
    selectCurrentMarketFees,
    selectCurrentMarketPosition,
  ],
  createTracking('selectUpdatedLiqCollateral', computeUpdatedCrossCollateral),
)

const selectUpdatedTotalAccountLiquidationValue = createSelector(
  [selectUpdatedLiqCollateral, selectUpdatedCrossUnrealizedPnl],
  createTracking('selectUpdatedTotalAccountLiquidationValue', computeTotalAccountLiquidationValue),
)

const selectUpdatedCrossMaintenanceMarginReq = createSelector(
  [selectUpdatedPositionsMarkPrices, selectPerpsOrderBookMetas, selectUpdatedCrossPositions],
  createTracking('selectUpdatedCrossMaintenanceMarginReq', computeTotalMaintenanceMarginReq),
)

const selectUpdatedLiqPrices = createSelector(
  [
    selectUpdatedPositionsMarkPrices,
    selectPerpsOrderBookMetas,
    selectUpdatedCrossMaintenanceMarginReq,
    selectUpdatedTotalAccountLiquidationValue,
    selectUpdatedPositions,
  ],
  createTracking('selectUpdatedLiqPrices', computePositionsLiqPrices),
)

export const selectUpdatedLiqPrice: (
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
) => number | undefined = createSelector(
  [selectUpdatedLiqPrices, selectCurrentMarketId],
  createTracking('selectUpdatedLiqPrice', (liqPrices, marketId) => liqPrices[marketId]),
)
