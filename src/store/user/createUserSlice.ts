import type { AccountLimits } from 'zklighter-perps'
import type { StateCreator } from 'zustand'

import type { OrderType } from '../../types/order'
import type { ExtendedUserTier, UserTier } from '../../types/user-tiers'
import { RouteType } from '../types'

export type AccountExistence =
  | 'GeoBlocked'
  | 'NoWallet'
  | 'Deciding'
  | 'KeysDontMatch'
  | 'ShouldDeposit'
  | 'DepositInProgress'
  | 'Creating'
  | 'Exists'

export type CloseAllPositionsFilter = 'all' | 'profitable' | 'lossMaking'

export type TradeChartSection =
  | 'price'
  | 'depth'
  | 'funding'
  | 'details'
  | 'order_book'
  | 'trades'
  | 'financials'

export interface UserSlice {
  accountIndex: number
  l1Address: string
  l1Initialized: boolean
  accountExistence: AccountExistence
  userTier: UserTier
  userTierName: ExtendedUserTier
  userTierLastUpdate: number | null
  accountLimits: AccountLimits | null
  proof: {
    message: string
    signature: string
  } | null
  didJustConnect: boolean
  showMarketSelector: boolean
  showOnboarding: boolean
  showWalletOptions: boolean
  showReferralModal: boolean
  showAirdropModal: boolean
  showFeeTiersModal: boolean
  showFeedback: boolean
  showAdjustSlippage: boolean
  showAdjustSLTPSlippage: boolean
  showAdjustAtomicSlippage: boolean
  showMarginModeModal: boolean
  showAccountTradingModeModal: boolean
  showReversePositionModal: boolean
  showLeverageModalByMarket: number | null
  showCloseAllPositionsModal: boolean
  closeAllPositionsFilter: CloseAllPositionsFilter
  showAnnouncementHistory: boolean
  showReferralInfo: boolean
  showReferralPoints: boolean
  showAccountTierSwitch: boolean
  showConfirmOrder: boolean
  showSpotPerpsTransferModal: boolean
  spotPerpsTransferModalFrom: RouteType
  transferModalToAccountIndex: number
  mobileLoginSignature: { pk: string; body: string } | null
  showCreateSubAccount: boolean
  showTransferModal: boolean
  showAWSWAFCaptcha: boolean
  orderTypesEducationType: OrderType | 'atomic' | 'chase-limit' | 'iceberg' | null
  tradeChartSection: TradeChartSection
}

export const createUserSlice: StateCreator<UserSlice, [], [], UserSlice> = () => ({
  accountIndex: 0,
  l1Address: '',
  l1Initialized: false,
  accountExistence: 'Deciding',
  userTier: null,
  userTierName: null,
  userTierLastUpdate: null,
  accountLimits: null,
  proof: null,
  didJustConnect: false,
  showMarketSelector: false,
  showOnboarding: false,
  showWalletOptions: false,
  showReferralModal: false,
  showAirdropModal: false,
  showFeeTiersModal: false,
  showFeedback: false,
  showAdjustSlippage: false,
  showAdjustSLTPSlippage: false,
  showAdjustAtomicSlippage: false,
  showMarginModeModal: false,
  showAccountTradingModeModal: false,
  showReversePositionModal: false,
  showLeverageModalByMarket: null,
  showCloseAllPositionsModal: false,
  closeAllPositionsFilter: 'all',
  showAnnouncementHistory: false,
  showReferralInfo: false,
  showReferralPoints: false,
  showAccountTierSwitch: false,
  showConfirmOrder: false,
  showSpotPerpsTransferModal: false,
  spotPerpsTransferModalFrom: RouteType.Spot,
  transferModalToAccountIndex: 0,
  mobileLoginSignature: null,
  showCreateSubAccount: false,
  showTransferModal: false,
  showAWSWAFCaptcha: false,
  orderTypesEducationType: null,
  tradeChartSection: 'price',
})
