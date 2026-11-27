import {
  OrderTypeEnum,
  TradesMarketTypeEnum,
  TradesRoleEnum,
  TradesTypeEnum,
  TransferHistoryTypeEnum,
} from 'zklighter-perps'

export const TABLE_FILTER_MARKET_TYPES = [
  TradesMarketTypeEnum.All,
  TradesMarketTypeEnum.Spot,
  TradesMarketTypeEnum.Perp,
] as const

export const ACTIVE_ORDER_FILTER_TYPES = [
  'all',
  OrderTypeEnum.Limit,
  OrderTypeEnum.StopLoss,
  OrderTypeEnum.StopLossLimit,
  OrderTypeEnum.TakeProfit,
  OrderTypeEnum.TakeProfitLimit,
  OrderTypeEnum.Twap,
] as const

export const ORDER_HISTORY_FILTER_TYPES = [
  'all',
  OrderTypeEnum.Market,
  OrderTypeEnum.Limit,
  OrderTypeEnum.StopLoss,
  OrderTypeEnum.StopLossLimit,
  OrderTypeEnum.TakeProfit,
  OrderTypeEnum.TakeProfitLimit,
  OrderTypeEnum.Twap,
] as const

export const TABLE_FILTER_TRADE_ROLES = [
  TradesRoleEnum.All,
  TradesRoleEnum.Maker,
  TradesRoleEnum.Taker,
] as const

export const TABLE_FILTER_TRADE_TYPES = [
  TradesTypeEnum.All,
  TradesTypeEnum.Trade,
  TradesTypeEnum.Liquidation,
  TradesTypeEnum.Deleverage,
  TradesTypeEnum.MarketSettlement,
] as const

export const TABLE_FILTER_TRANSFER_TYPES = [
  TransferHistoryTypeEnum.All,
  TransferHistoryTypeEnum.L2Transfer,
  TransferHistoryTypeEnum.L2MintShares,
  TransferHistoryTypeEnum.L2BurnShares,
  TransferHistoryTypeEnum.L2StakeAssets,
  TransferHistoryTypeEnum.L2UnstakeAssets,
  TransferHistoryTypeEnum.L2CreatePublicPool,
  TransferHistoryTypeEnum.L2CreateStakingPool,
  TransferHistoryTypeEnum.L1BurnShares,
  TransferHistoryTypeEnum.L1UnstakeAssets,
  TransferHistoryTypeEnum.ReferralProgramPayout,
] as const
