import type {
  Asset as BEAsset,
  MarketConfig,
  SpotOrderBookDetail as BESpotOrderBookDetail,
  PerpsOrderBookDetail as BEPerpsOrderBookDetail,
} from 'zklighter-perps'

type StrippedMarketStatsFields =
  | 'last_trade_price'
  | 'daily_trades_count'
  | 'daily_base_token_volume'
  | 'daily_quote_token_volume'
  | 'daily_price_low'
  | 'daily_price_high'
  | 'daily_price_change'
  | 'daily_chart'
  | 'open_interest'
  | 'lifetime_quote_token_volume'
  | 'lifetime_base_token_volume'

type BOEventFields =
  | 'event_index'
  | 'start_timestamp'
  | 'end_timestamp'
  | 'market_admin_account_index'
  | 'outcome'
  | 'settlement_cap'
  | 'settlement_type'
  | 'settlement_price'
  | 'default_price'

export type SpotOrderBookDetail = Omit<
  BESpotOrderBookDetail,
  'market_type' | 'marketSlotId' | StrippedMarketStatsFields | BOEventFields
> & {
  market_type: 'spot'
  backend_symbol: string
  display_price_decimals: number
  display_size_decimals: number
}

export type PerpsOrderBookDetail = Omit<
  BEPerpsOrderBookDetail,
  'market_type' | 'marketSlotId' | StrippedMarketStatsFields | BOEventFields | 'market_config'
> & {
  market_type: 'perp'
  market_config?: MarketConfig
  backend_symbol: string
  display_price_decimals: number
  display_size_decimals: number
}

export type OrderBookDetail = SpotOrderBookDetail | PerpsOrderBookDetail

export type AssetMeta = Omit<BEAsset, 'index_price' | 'total_supplied' | 'decimals'> & {
  backend_symbol: string
  size_decimals: number
  display_price_decimals: number
  display_size_decimals: number
}
