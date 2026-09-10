import {
  type PublicPoolInfo as CodegenPublicPoolInfo,
  type PositionFunding as CodegenedPositionFunding,
  type PublicPoolShare as CodegenedPublicPoolShare,
  type Liquidation as CodegenedLiquidation,
  type PublicPoolMetadata as CodegenedPublicPoolMetadata,
  type AccountAsset as CodegenedAccountAsset,
  type DetailedAccount as CodegenedDetailedAccount,
  type PendingUnlock as CodegenedPendingUnlock,
} from 'zklighter-perps'
import type { RfqListStatusEnum } from 'zklighter-perps/apis/AccountApi'

import type {
  WsOrderbookItem,
  WsPoolInfo,
  WsTx,
  WsShare,
  WsOrder,
  WsSpotAvgEntryPrice,
  WsAssetBalance,
  WsPosition,
  WsRfq,
  WsTrade,
} from '../lighter-ws/types'

// don't use Ws models directly in case we want to modify any fields
export type Trade = WsTrade
export type OrderbookItem = WsOrderbookItem
export type Position = WsPosition
export type AssetBalance = WsAssetBalance
export type SpotAvgEntryPrice = WsSpotAvgEntryPrice
export type Share = WsShare
export type Order = WsOrder
export type Rfq = WsRfq

/** The order book captured at the moment an rfq was requested. */
export interface RfqOrderBookSnapshot {
  asks: OrderbookItem[]
  bids: OrderbookItem[]
}

export type PoolInfo = WsPoolInfo
export type Tx = WsTx
export type Account = {
  trades?: Record<string, Trade[]>
  positions?: Record<string, Position>
  assetBalances?: Record<string, AssetBalance>
  spotAvgEntryPrices?: Record<string, SpotAvgEntryPrice>
  activeOrders?: Record<string, Order[]>
  inactiveOrders?: Record<string, Order[]>
  shares?: Share[]
  rfqs?: Record<string, Record<string, Rfq>>
  totalVolume?: number
  monthlyVolume?: number
  weeklyVolume?: number
  dailyVolume?: number
  poolInfo?: PoolInfo
  livePoints?: number
}
export type AccountAsset = Omit<
  CodegenedAccountAsset,
  'balance' | 'locked_balance' | 'margin_balance' | 'multiplier'
> & {
  balance: number
  locked_balance: number
  margin_balance: number
  multiplier: number
}
export type PublicPoolShare = Omit<CodegenedPublicPoolShare, 'principal_amount' | 'entry_usdc'> & {
  principal_amount: number
  entry_usdc: number
}
export type PendingUnlock = Omit<CodegenedPendingUnlock, 'amount'> & {
  amount: number
}
export type PublicPoolInfo = Omit<
  CodegenPublicPoolInfo,
  'operator_fee' | 'min_operator_share_rate'
> & {
  operator_fee: number
  min_operator_share_rate: number
}
export type PublicPoolMetadata = Omit<
  CodegenedPublicPoolMetadata,
  | 'operator_fee'
  | 'total_asset_value'
  | 'total_spot_value'
  | 'total_perps_value'
  | 'assets'
  | 'account_share'
> & {
  operator_fee: number
  total_asset_value: number
  total_spot_value: number
  total_perps_value: number
  assets: AccountAsset[]
  account_share?: PublicPoolShare
}
export type DetailedAccount = Omit<
  CodegenedDetailedAccount,
  | 'available_balance'
  | 'collateral'
  | 'total_asset_value'
  | 'cross_asset_value'
  | 'cross_initial_margin_requirement'
  | 'cross_maintenance_margin_requirement'
  | 'referral_points_percentage'
  | 'assets'
  | 'shares'
  | 'pending_unlocks'
  | 'pool_info'
> & {
  available_balance: number
  collateral: number
  total_asset_value: number
  cross_asset_value: number
  cross_initial_margin_requirement: number
  cross_maintenance_margin_requirement: number
  referral_points_percentage: number
  assets: AccountAsset[]
  shares: PublicPoolShare[]
  pending_unlocks?: PendingUnlock[]
  // the API omits pool_info for non-pool accounts even though codegen marks it required
  pool_info?: PublicPoolInfo
}
export type PositionFunding = Omit<
  CodegenedPositionFunding,
  'change' | 'rate' | 'position_size'
> & {
  change: number
  rate: number
  position_size: number
}

export type Liquidation = Omit<CodegenedLiquidation, 'info'> & {
  info: Omit<CodegenedLiquidation['info'], 'positions'> & {
    positions: Position[]
  }
}

export enum SubAccountType {
  Main = 0,
  Sub = 1,
  Public = 2,
  LighterPublic = 3,
  Staking = 4,
}

export enum RouteType {
  Perps = 0,
  Spot = 1,
}

export interface ActiveRfqIntent {
  acknowledged: number
  approved: number
  baseAmount?: string
  createdAt: number
  declined: number
  isShort: boolean
  marketId: number
  quoteAmount?: string
  rfqId?: number
  rfqStatus: RfqListStatusEnum
}
