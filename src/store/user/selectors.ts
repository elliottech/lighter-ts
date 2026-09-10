import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import type { UserSlice } from './createUserSlice'

export const selectUserAccountIndex = (state: UserSlice) => state.accountIndex

export const selectUserTier = (state: UserSlice) => state.userTier

export const selectUserTierName = (state: UserSlice) => state.userTierName

export const selectUserTierLastUpdate = (state: UserSlice) => state.userTierLastUpdate

export const selectProof = (state: UserSlice) => state.proof

export const selectAccountExistence = (state: UserSlice) => state.accountExistence

export const selectL1Initialized = (state: UserSlice) => state.l1Initialized

export const selectShowMarketSelector = (state: UserSlice) => state.showMarketSelector

export const selectShowOnboarding = (state: UserSlice) => state.showOnboarding

export const selectShowWalletOptions = (state: UserSlice) => state.showWalletOptions

export const selectShowFeeTiersModal = (state: UserSlice) => state.showFeeTiersModal

export const selectShowFeedback = (state: UserSlice) => state.showFeedback

export const selectShowAdjustSlippage = (state: UserSlice) => state.showAdjustSlippage

export const selectShowAdjustSLTPSlippage = (state: UserSlice) => state.showAdjustSLTPSlippage

export const selectShowAdjustAtomicSlippage = (state: UserSlice) => state.showAdjustAtomicSlippage

export const selectShowMarginModeModal = (state: UserSlice) => state.showMarginModeModal

export const selectShowAccountTradingModeModal = (state: UserSlice) =>
  state.showAccountTradingModeModal

export const selectShowReversePositionModal = (state: UserSlice) => state.showReversePositionModal

export const selectShowLeverageModalByMarket = (state: UserSlice) => state.showLeverageModalByMarket

export const selectOrderTypesEducationType = (state: UserSlice) => state.orderTypesEducationType

export const selectShowCloseAllPositionsModal = (state: UserSlice) =>
  state.showCloseAllPositionsModal

export const selectCloseAllPositionsFilter = (state: UserSlice) => state.closeAllPositionsFilter

export const selectShowReferralInfo = (state: UserSlice) => state.showReferralInfo

export const selectShowAccountTierSwitch = (state: UserSlice) => state.showAccountTierSwitch

export const selectShowConfirmOrder = (state: UserSlice) => state.showConfirmOrder

export const selectShowSpotPerpsTransferModal = (state: UserSlice) =>
  state.showSpotPerpsTransferModal

export const selectSpotPerpsTransferModalFrom = (state: UserSlice) =>
  state.spotPerpsTransferModalFrom

export const selectTransferModalToAccountIndex = (state: UserSlice) =>
  state.transferModalToAccountIndex

export const selectShowCreateSubAccount = (state: UserSlice) => state.showCreateSubAccount

export const selectShowTransferModal = (state: UserSlice) => state.showTransferModal

export const selectL1Address = (state: UserSlice) => state.l1Address

const selectAccountLimits = (state: UserSlice) => state.accountLimits

export const selectEffectiveLit = createSelector(
  [selectAccountLimits],
  createTracking('selectEffectiveLit', (accountLimits) =>
    Number(accountLimits?.effective_lit_stakes ?? 0),
  ),
)

export const selectLeasedLit = createSelector(
  [selectAccountLimits],
  createTracking('selectLeasedLit', (accountLimits) => Number(accountLimits?.leased_lit ?? 0)),
)

export const selectTotalEffectiveLit = createSelector(
  [selectEffectiveLit, selectLeasedLit],
  createTracking('selectTotalEffectiveLit', (effectiveLit, leasedLit) => effectiveLit + leasedLit),
)

export const selectFeeTicks = createSelector(
  [selectAccountLimits],
  createTracking('selectFeeTicks', (accountLimits) => {
    if (!accountLimits) {
      return null
    }
    return {
      takerFeeTick: accountLimits.current_taker_fee_tick,
      makerFeeTick: accountLimits.current_maker_fee_tick,
    }
  }),
)

export const selectShowAWSWAFCaptcha = (state: UserSlice) => state.showAWSWAFCaptcha

export const selectTradeChartSection = (state: UserSlice) => state.tradeChartSection
