import type {
  Candle,
  MarkPriceCandle,
  RFQResponseEntry,
  OrderStatusEnum,
  OrderTimeInForceEnum,
  OrderTriggerStatusEnum,
  OrderTypeEnum,
  TradeTypeEnum,
  AccountAssetMarginModeEnum,
  AccountPositionMarginModeEnum,
  PublicPoolInfoStatusEnum,
  RFQEntryDirectionEnum,
  AccountBinaryOptionsPositionSignEnum,
  BinaryOptionMarketStatsOutcomeEnum,
  BinaryOptionMarketStatsStatusEnum,
  OrderMarketKindEnum,
  TradeMarketKindEnum,
} from 'zklighter-perps'
import type { RfqListStatusEnum } from 'zklighter-perps/apis/AccountApi'

export interface WsOrderbookItem {
  price: number
  size: number
}

export interface WsOrderbook {
  asks: WsOrderbookItem[]
  bids: WsOrderbookItem[]
}

export interface WsTrade {
  ask_id: number
  bid_id: number
  ask_id_str?: string | null
  bid_id_str?: string | null
  block_height: number
  is_maker_ask: boolean
  ask_account_id: number
  market_id: number
  market_symbol: string
  market_kind: TradeMarketKindEnum
  size: number
  price: number
  usd_amount: number
  bid_account_id: number
  timestamp: number
  trade_id: number
  tx_hash: string
  type: TradeTypeEnum
  taker_fee: number
  maker_fee: number
  integrator_taker_fee: number
  integrator_maker_fee: number
  taker_position_size_before: number | null
  taker_entry_quote_before: number | null
  taker_position_sign_changed?: boolean | null
  taker_initial_margin_fraction_before?: number | null
  maker_position_size_before: number | null
  maker_entry_quote_before: number | null
  maker_position_sign_changed?: boolean | null
  maker_initial_margin_fraction_before?: number | null
  ask_account_pnl: number | null
  bid_account_pnl: number | null
}

export interface WsOrder {
  filled_base_amount: number
  filled_quote_amount: number
  initial_base_amount: number
  remaining_base_amount: number
  is_ask: boolean
  market_index: number
  market_symbol: string
  market_kind: OrderMarketKindEnum
  nonce: number
  owner_account_index: number
  price: number
  reduce_only: boolean
  trigger_price: number
  order_expiry: number
  order_id: string
  client_order_index: number
  parent_order_id: string
  to_cancel_order_id_0: string
  trigger_status: OrderTriggerStatusEnum
  status: OrderStatusEnum
  created_at: number
  updated_at: number
  type: OrderTypeEnum
  time_in_force: OrderTimeInForceEnum
}

export interface WsPosition {
  market_id: number
  initial_margin_fraction: number
  sign: number
  position: number
  avg_entry_price: number
  margin_mode: AccountPositionMarginModeEnum
  allocated_margin: number
  total_funding_paid_out: number
  total_discount: number
  margin_set_flag: number
}

export interface WsBOPosition {
  market_id: number
  entry_quote: number
  sign: AccountBinaryOptionsPositionSignEnum
  size: number
  avg_entry_price: number
}

export interface WsAssetBalance {
  asset_id: number
  margin_mode: AccountAssetMarginModeEnum
  balance: number
  margin_balance: number
  locked_balance: number
  available_balance: number
  available_margin_balance: number
}

export interface WsSpotAvgEntryPrice {
  asset_id: number
  avg_entry_price: number
  asset_size: number
  last_trade_id: number
}

export interface WsShare {
  public_pool_index: number
  shares_amount: number
  principal_amount: number
  entry_timestamp: number
}

interface WsBaseMarketStats {
  market_id: number
  daily_base_token_volume: number
  daily_price_change: number
  daily_price_high: number
  daily_price_low: number
  daily_quote_token_volume: number
  last_trade_price: number
  mid_price: number
  best_bid_price: number
  best_ask_price: number
}

export interface WsSpotMarketStats extends WsBaseMarketStats {
  index_price: number
}

export interface WsPerpsMarketStats extends WsSpotMarketStats {
  funding_timestamp: number
  current_funding_rate: number
  mark_price: number
  open_interest: number
  open_interest_limit: number
  funding_clamp_big: number
  funding_clamp_small: number
}

export interface WsBOMarketStats extends WsBaseMarketStats {
  symbol: string
  lifetime_quote_token_volume: number
  lifetime_base_token_volume: number
  open_interest: number
  status: BinaryOptionMarketStatsStatusEnum
  outcome: BinaryOptionMarketStatsOutcomeEnum
}

export interface WsUpDownCandle {
  symbol: string
  duration: string
  resolution: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  sample_count: number
  provider: string
  feed_id: string
}

export interface WsSubscribedUpDownCandleMessage {
  type: 'subscribed/up_down_candle'
  channel: string
  candles: WsUpDownCandle[]
}

export interface WsUpdateUpDownCandleMessage {
  type: 'update/up_down_candle'
  channel: string
  candles: WsUpDownCandle[]
}

export interface WsAssetStats {
  asset_id: number
  index_price: number
  total_supplied: number
}

export interface WsRfq {
  id: number
  account_index: number
  market_index: number
  direction: RFQEntryDirectionEnum
  base_amount: number
  quote_amount: number
  status: RfqListStatusEnum
  responses: RFQResponseEntry[]
  created_at: number
  updated_at: number
}

export interface WsTx {
  hash: string
  status: number
  event_info: string
}

export interface WsPoolInfo {
  operator_fee: number
  min_operator_share_rate: number
  total_shares: number
  operator_shares: number
  status: PublicPoolInfoStatusEnum
  annual_percentage_yield: number
}

// Notification types

interface WsCoreNotification {
  account_index: number
  ack: false
  acked_at: null
  id: string
}

interface WsAnnouncementNotificationContent {
  title: string
  message: string
}

interface WsEventNotificationContent {
  market_index: number
  size: number
  timestamp: string | Date | number
  usdc_amount: number
  // present on deleverage notifications only (account indexes as strings;
  // maker = deleveraged side, taker = bankrupt)
  ask_account_id?: string
  bid_account_id?: string
  is_maker_ask?: boolean
}

export type WsNotification =
  | (WsCoreNotification & { kind: 'deleverage'; content: WsEventNotificationContent })
  | (WsCoreNotification & { kind: 'liquidation'; content: WsEventNotificationContent })
  | (WsCoreNotification & { kind: 'announcement'; content: WsAnnouncementNotificationContent })

// Message types

export interface WsSubscribedOrderBookMessage {
  type: 'subscribed/order_book'
  channel: string
  order_book: WsOrderbook
}

export interface WsUpdateOrderBookMessage {
  type: 'update/order_book'
  channel: string
  order_book: WsOrderbook
}

export interface WsSubscribedTradeMessage {
  type: 'subscribed/trade_fe'
  channel: string
  trades: WsTrade[] | null
  liquidation_trades?: WsTrade[] | null
}

export interface WsUpdateTradeMessage {
  type: 'update/trade_fe'
  channel: string
  trades: WsTrade[]
  liquidation_trades?: WsTrade[] | null
}

export interface WsSubscribedCandleMessage {
  type: 'subscribed/candle'
  channel: string
  timestamp: number
  candles: Candle[]
}

export interface WsUpdateCandleMessage {
  type: 'update/candle'
  channel: string
  timestamp: number
  candles: Candle[]
}

export interface WsSubscribedMarkPriceCandleMessage {
  type: 'subscribed/mark_price_candle'
  channel: string
  timestamp: number
  candles: MarkPriceCandle[]
}

export interface WsUpdateMarkPriceCandleMessage {
  type: 'update/mark_price_candle'
  channel: string
  timestamp: number
  candles: MarkPriceCandle[]
}

export interface WsSubscribedPerpsMarketStatsMessage {
  type: 'subscribed/market_stats'
  channel: string
  timestamp: number
  market_stats: Record<string, WsPerpsMarketStats>
}

export interface WsUpdatePerpsMarketStatsMessage {
  type: 'update/market_stats'
  channel: string
  timestamp: number
  market_stats: Record<string, Partial<WsPerpsMarketStats>>
}

export interface WsSubscribedSpotMarketStatsMessage {
  type: 'subscribed/spot_market_stats'
  channel: string
  timestamp: number
  spot_market_stats: Record<string, WsSpotMarketStats>
}

export interface WsUpdateSpotMarketStatsMessage {
  type: 'update/spot_market_stats'
  channel: string
  timestamp: number
  spot_market_stats: Record<string, Partial<WsSpotMarketStats>>
}

export interface WsSubscribedBOMarketStatsMessage {
  type: 'subscribed/bo_market_stats'
  channel: string
  bo_market_stats: Record<string, WsBOMarketStats>
}

export interface WsUpdateBOMarketStatsMessage {
  type: 'update/bo_market_stats'
  channel: string
  bo_market_stats: Record<string, Partial<WsBOMarketStats>>
}

export interface WsSubscribedAssetStatsMessage {
  type: 'subscribed/asset_stats'
  channel: string
  asset_stats: Record<string, WsAssetStats>
}

export interface WsUpdateAssetStatsMessage {
  type: 'update/asset_stats'
  channel: string
  asset_stats: Record<string, WsAssetStats>
}

export interface WsSubscribedAssetBalancesMessage {
  type: 'subscribed/account_all_assets'
  channel: string
  assets: Record<string, WsAssetBalance>
}

export interface WsUpdateAssetBalancesMessage {
  type: 'update/account_all_assets'
  channel: string
  assets: Record<string, WsAssetBalance>
}

export interface WsSubscribedSpotAvgEntryPricesMessage {
  type: 'subscribed/account_spot_avg_entry_prices'
  channel: string
  avg_entry_prices: Record<string, WsSpotAvgEntryPrice>
}

export interface WsUpdateSpotAvgEntryPricesMessage {
  type: 'update/account_spot_avg_entry_prices'
  channel: string
  avg_entry_prices: Record<string, WsSpotAvgEntryPrice>
}

export interface WsSubscribedAccountTradesMessage {
  type: 'subscribed/account_all_trades'
  channel: string
  total_volume: number
}

export interface WsUpdateAccountTradesMessage {
  type: 'update/account_all_trades'
  channel: string
  trades: Record<string, WsTrade[]>
}

export interface WsSubscribedAccountPositionsMessage {
  type: 'subscribed/account_all_positions_fe'
  channel: string
  positions: Record<string, WsPosition>
  bo_positions: Record<string, WsBOPosition>
  shares: WsShare[]
}

export interface WsUpdateAccountPositionsMessage {
  type: 'update/account_all_positions_fe'
  channel: string
  positions: Record<string, WsPosition>
  bo_positions: Record<string, WsBOPosition>
  last_funding_round?: Record<string, number>
  last_funding_discount?: Record<string, number>
  shares: WsShare[]
}

export interface WsSubscribedAccountOrdersMessage {
  type: 'subscribed/account_all_orders'
  channel: string
  orders: Record<string, WsOrder[]>
}

export interface WsUpdateAccountOrdersMessage {
  type: 'update/account_all_orders'
  channel: string
  orders: Record<string, WsOrder[]>
}

export interface WsSubscribedLivePointsMessage {
  type: 'subscribed/live_points'
  channel: string
  total_live_points: number
}

export interface WsUpdateLivePointsMessage {
  type: 'update/live_points'
  channel: string
  total_live_points: number
}
export interface WsAgentAnsweredQA {
  question: string
  answer: string
  timestamp: number
  response_ms?: number
}

export interface WsAgentPendingQA {
  question: string
  timestamp: number
}

export interface WsSubscribedAgentMessage {
  type: 'subscribed/agent'
  channel: string
  history: WsAgentAnsweredQA[]
  pending?: WsAgentPendingQA
}

export interface WsAckAgentMessage {
  type: 'ack/agent'
  channel: string
  status: string
  id: string
}

export interface WsUpdateAgentMessage {
  type: 'update/agent'
  channel: string
  answer: string
  response_ms?: number
  id: string
}

export interface WsSubscribedRfqsMessage {
  type: 'subscribed/rfq'
  channel: string
  rfqs: WsRfq[]
}

export interface WsUpdateRfqsMessage {
  type: 'update/rfq'
  channel: string
  rfqs: WsRfq[]
}

interface WsUnsubscribeMessage {
  type: 'unsubscribed'
  channel: string
}

interface WsSubscribedExecutedTransactionMessage {
  type: 'subscribed/account_tx'
  channel: string
}

export interface WsUpdateExecutedTransactionMessage {
  type: 'update/account_tx'
  channel: string
  txs: WsTx[]
}

export interface WsSubscribedPoolInfoMessage {
  type: 'subscribed/pool_info'
  channel: string
  pool_info: WsPoolInfo
}

export interface WsUpdatePoolInfoMessage {
  type: 'update/pool_info'
  channel: string
  pool_info: WsPoolInfo
}

export interface WsSubscribedHeightMessage {
  type: 'subscribed/height'
  channel: string
  height: number
}

export interface WsUpdateHeightMessage {
  type: 'update/height'
  channel: string
  height: number
}

export interface WsSubscribeNotificationMessage {
  type: 'subscribed/notification'
  channel: string
  notifs: WsNotification[]
}

export interface WsUpdateNotificationMessage {
  type: 'update/notification'
  channel: string
  notifs: WsNotification[]
}

interface WsConnectedMessage {
  type: 'connected'
  session_id: string
}

interface WsPingMessage {
  type: 'ping'
}

interface WsPongMessage {
  type: 'pong'
}

export interface WsErrorMessage {
  type: undefined
  error: {
    code: number
    message: string
  }
}

export type WsMessage =
  | WsSubscribedOrderBookMessage
  | WsUpdateOrderBookMessage
  | WsSubscribedTradeMessage
  | WsUpdateTradeMessage
  | WsSubscribedCandleMessage
  | WsUpdateCandleMessage
  | WsSubscribedMarkPriceCandleMessage
  | WsUpdateMarkPriceCandleMessage
  | WsSubscribedPerpsMarketStatsMessage
  | WsUpdatePerpsMarketStatsMessage
  | WsSubscribedSpotMarketStatsMessage
  | WsUpdateSpotMarketStatsMessage
  | WsSubscribedBOMarketStatsMessage
  | WsUpdateBOMarketStatsMessage
  | WsSubscribedUpDownCandleMessage
  | WsUpdateUpDownCandleMessage
  | WsSubscribedAssetStatsMessage
  | WsUpdateAssetStatsMessage
  | WsSubscribedAssetBalancesMessage
  | WsUpdateAssetBalancesMessage
  | WsSubscribedSpotAvgEntryPricesMessage
  | WsUpdateSpotAvgEntryPricesMessage
  | WsSubscribedAccountTradesMessage
  | WsUpdateAccountTradesMessage
  | WsSubscribedAccountPositionsMessage
  | WsUpdateAccountPositionsMessage
  | WsSubscribedAccountOrdersMessage
  | WsUpdateAccountOrdersMessage
  | WsSubscribedLivePointsMessage
  | WsUpdateLivePointsMessage
  | WsSubscribedRfqsMessage
  | WsUpdateRfqsMessage
  | WsSubscribedAgentMessage
  | WsAckAgentMessage
  | WsUpdateAgentMessage
  | WsUnsubscribeMessage
  | WsSubscribedExecutedTransactionMessage
  | WsUpdateExecutedTransactionMessage
  | WsSubscribedPoolInfoMessage
  | WsUpdatePoolInfoMessage
  | WsSubscribedHeightMessage
  | WsUpdateHeightMessage
  | WsSubscribeNotificationMessage
  | WsUpdateNotificationMessage
  | WsConnectedMessage
  | WsPingMessage
  | WsPongMessage
  | WsErrorMessage
