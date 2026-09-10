import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import type { PreferencesSlice } from './createPreferencesSlice'

export const selectOrderBookGroupBy = (state: PreferencesSlice) =>
  state.preferences.orderBookGroupBy

export const selectMarketTradesFilterBy = (state: PreferencesSlice) =>
  state.preferences.marketTradesFilterBy

export const selectMaxSlippage = (state: PreferencesSlice) => state.preferences.maxSlippage

export const selectMaxSLTPSlippage = (state: PreferencesSlice) => state.preferences.maxSLTPSlippage

export const selectConditionalLimitPrefill = (state: PreferencesSlice) =>
  state.preferences.conditionalLimitPrefill

export const selectHideSmallBalances = (state: PreferencesSlice) =>
  state.preferences.hideSmallBalances

export const selectIsAmountInBase = (state: PreferencesSlice) => state.preferences.isAmountInBase

export const selectDateFormatting = (state: PreferencesSlice) => state.preferences.dateFormatting

const selectFavoriteMarkets = (state: PreferencesSlice) => state.preferences.favoriteMarkets

export const selectFavoriteMarketsMap = createSelector(
  [selectFavoriteMarkets],
  createTracking('selectFavoriteMarketsMap', (favoriteMarkets) => {
    return favoriteMarkets.reduce<Record<string, boolean>>((acc, marketId) => {
      acc[marketId] = true
      return acc
    }, {})
  }),
)

export const selectCurrentAtomic = (state: PreferencesSlice) => state.preferences.currentAtomic
export const selectAtomicOrderSize = (state: PreferencesSlice) =>
  state.preferences.atomicInput.orderSize
export const selectAtomicPinnedInput = (state: PreferencesSlice) =>
  state.preferences.atomicInput.sizeType

export const selectAtomicReduceOnly = (state: PreferencesSlice) =>
  state.preferences.atomicReduceOnly

export const selectAtomicIsTwap = (state: PreferencesSlice) => state.preferences.atomicIsTwap

export const selectAtomicMaxSlippage = (state: PreferencesSlice) =>
  state.preferences.atomicMaxSlippage

export const selectCurrentRfqIds = (state: PreferencesSlice) => state.preferences.currentRfqIds

export const selectRfqOrderBookSnapshots = (state: PreferencesSlice) =>
  state.preferences.rfqOrderBookSnapshots
