import type {
  AccountAsset as CodegenedAccountAsset,
  AccountBinaryOptionsPosition,
  AccountPosition,
  BinaryOptionMarketStats,
  DetailedAccount as CodegenedDetailedAccount,
  Liquidation as CodegenedLiquidation,
  Order as CodegenedOrder,
  PositionFunding as CodegenedPositionFunding,
  PublicPoolShare as CodegenedPublicPoolShare,
  RespCreateRFQ,
  Trade as CodegenedTrade,
  PublicPoolMetadata as CodegenedPublicPoolMetadata,
} from 'zklighter-perps'
import type {
  AccountAsset,
  BOPosition,
  DetailedAccount,
  Liquidation,
  Order,
  Position,
  PositionFunding,
  PublicPoolMetadata,
  PublicPoolShare,
  Rfq,
  Trade,
} from '../store/types'
import type { WsBOMarketStats } from '../lighter-ws/types/WsMessage'
import { marginPercentageToFraction } from '../formulas/marginPercentageToFraction'
import { toNullableNumber } from './common'
import { roundNumber } from './precision'

const convertAccountAsset = (asset: CodegenedAccountAsset): AccountAsset => ({
  ...asset,
  balance: Number(asset.balance),
  locked_balance: Number(asset.locked_balance),
  margin_balance: Number(asset.margin_balance),
  multiplier: Number(asset.multiplier),
})

const convertPublicPoolShare = (share: CodegenedPublicPoolShare): PublicPoolShare => ({
  ...share,
  entry_usdc: Number(share.entry_usdc),
  principal_amount: Number(share.principal_amount),
})

export const convertPublicPoolMetadata = (
  publicPool: CodegenedPublicPoolMetadata,
): PublicPoolMetadata => ({
  ...publicPool,
  operator_fee: Number(publicPool.operator_fee),
  total_asset_value: Number(publicPool.total_asset_value),
  total_spot_value: Number(publicPool.total_spot_value),
  total_perps_value: Number(publicPool.total_perps_value),
  assets: publicPool.assets.map(convertAccountAsset),
  account_share: publicPool.account_share
    ? convertPublicPoolShare(publicPool.account_share)
    : undefined,
})

const convertAccountBOPosition = (position: AccountBinaryOptionsPosition): BOPosition => ({
  ...position,
  entry_quote: Number(position.entry_quote),
  avg_entry_price: Number(position.avg_entry_price),
  size: Number(position.size),
})

export const convertDetailedAccount = (account: CodegenedDetailedAccount): DetailedAccount => ({
  ...account,
  available_balance: Number(account.available_balance),
  collateral: Number(account.collateral),
  total_asset_value: Number(account.total_asset_value),
  cross_asset_value: Number(account.cross_asset_value),
  cross_initial_margin_requirement: Number(account.cross_initial_margin_requirement),
  cross_maintenance_margin_requirement: Number(account.cross_maintenance_margin_requirement),
  referral_points_percentage: Number(account.referral_points_percentage),
  assets: account.assets.map(convertAccountAsset),
  shares: account.shares.map(convertPublicPoolShare),
  pending_unlocks: account.pending_unlocks?.map((pendingUnlock) => ({
    ...pendingUnlock,
    amount: Number(pendingUnlock.amount),
  })),
  bo_positions: account.bo_positions?.map(convertAccountBOPosition),
  // the API omits pool_info for non-pool accounts even though codegen marks it required
  pool_info: account.pool_info
    ? {
        ...account.pool_info,
        operator_fee: Number(account.pool_info.operator_fee),
        min_operator_share_rate: Number(account.pool_info.min_operator_share_rate),
      }
    : undefined,
})

export const convertTrade = (trade: CodegenedTrade): Trade => ({
  ...trade,
  taker_fee: trade.taker_fee ?? 0,
  maker_fee: trade.maker_fee ?? 0,
  integrator_maker_fee: trade.integrator_maker_fee ?? 0,
  integrator_taker_fee: trade.integrator_taker_fee ?? 0,
  usd_amount: Number(trade.usd_amount),
  price: Number(trade.price),
  size: Number(trade.size),
  taker_position_size_before: toNullableNumber(trade.taker_position_size_before),
  taker_entry_quote_before: toNullableNumber(trade.taker_entry_quote_before),
  maker_position_size_before: toNullableNumber(trade.maker_position_size_before),
  maker_entry_quote_before: toNullableNumber(trade.maker_entry_quote_before),
  ask_account_pnl: toNullableNumber(trade.ask_account_pnl),
  bid_account_pnl: toNullableNumber(trade.bid_account_pnl),
})

export const convertOrder = (order: CodegenedOrder): Order => ({
  ...order,
  filled_base_amount: Number(order.filled_base_amount),
  filled_quote_amount: Number(order.filled_quote_amount),
  initial_base_amount: Number(order.initial_base_amount),
  remaining_base_amount: Number(order.remaining_base_amount),
  price: Number(order.price),
  trigger_price: Number(order.trigger_price),
})

export const convertRfq = (rfq: RespCreateRFQ): Rfq => ({
  ...rfq,
  base_amount: Number(rfq.base_amount),
  quote_amount: Number(rfq.quote_amount),
})

export const convertPositionFunding = (funding: CodegenedPositionFunding): PositionFunding => ({
  ...funding,
  change: Number(funding.change),
  rate: Number(funding.rate),
  position_size: Number(funding.position_size),
})

const convertAccountPosition = (accountPosition: AccountPosition): Position => ({
  ...accountPosition,
  initial_margin_fraction: marginPercentageToFraction(
    Number(accountPosition.initial_margin_fraction),
  ),
  position: Number(accountPosition.position),
  avg_entry_price: Number(accountPosition.avg_entry_price),
  total_funding_paid_out: Number(accountPosition.total_funding_paid_out),
  total_discount: Number(accountPosition.total_discount),
  allocated_margin: Number(accountPosition.allocated_margin),
})

export const convertLiquidation = (liquidation: CodegenedLiquidation): Liquidation => ({
  ...liquidation,
  info: {
    ...liquidation.info,
    positions: liquidation.info.positions.map(convertAccountPosition),
  },
})

export const convertBOMarketStats = (stats: BinaryOptionMarketStats): WsBOMarketStats => ({
  ...stats,
  daily_quote_token_volume: roundNumber(stats.daily_quote_token_volume, 2),
  lifetime_quote_token_volume: roundNumber(stats.lifetime_quote_token_volume, 2),
  lifetime_base_token_volume: roundNumber(stats.lifetime_base_token_volume, 2),
  daily_price_change: roundNumber(stats.daily_price_change / 100, 4),
  last_trade_price: Number(stats.last_trade_price),
  mid_price: Number(stats.mid_price),
  best_bid_price: Number(stats.best_bid_price),
  best_ask_price: Number(stats.best_ask_price),
  open_interest: Number(stats.open_interest),
})
