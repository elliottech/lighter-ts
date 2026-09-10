import { computeLimitOrders, computeLimitOrdersInBase } from '../../formulas/scale'
import type { UserTier } from '../../types/user-tiers'
import type { AccountsSlice } from '../accounts/createAccountsSlice'
import type { OrderBookSlice } from '../orderbook/createOrderBookSlice'
import { selectCurrentMarket } from '../orderbook/selectors'
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
import type { UserSlice } from '../user/createUserSlice'
import { selectUserTier } from '../user/selectors'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import {
  selectBaseAmount,
  selectPositionAwareIsShort,
  selectScalePriceDistribution,
  selectScaleSizeDistribution,
} from './common'

export const selectScaleLimitOrders = createSelector(
  [
    selectBaseAmount,
    selectScalePriceDistribution,
    selectScaleSizeDistribution,
    selectPositionAwareIsShort,
  ],
  createTracking('selectScaleLimitOrders', computeLimitOrders),
)

export const selectScaleLimitOrdersInBase: (
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
    OptionalDirection &
    OptionalAccountIndex &
    OptionalAssetId,
) => { baseAmount: number; price: number }[] = createSelector(
  [selectScaleLimitOrders, selectBaseAmount, selectCurrentMarket],
  createTracking('selectScaleLimitOrdersInBase', computeLimitOrdersInBase),
)

const STANDARD_SCALE_MAX_ORDER_COUNT = 20
// Server allows at most 50 txs per sendTxBatch (error 21514); a 50-order batch
// is ~25KB, far below the 1MiB request body limit.
const PREMIUM_SCALE_MAX_ORDER_COUNT = 50

export const selectScaleMaxOrderCount = createSelector(
  [selectUserTier],
  createTracking('selectScaleMaxOrderCount', (tier: UserTier) =>
    tier === 'plus' || tier === 'premium'
      ? PREMIUM_SCALE_MAX_ORDER_COUNT
      : STANDARD_SCALE_MAX_ORDER_COUNT,
  ),
)
