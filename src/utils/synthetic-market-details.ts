import type { MarketConfig } from 'zklighter-perps'

import type { PerpsOrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'

const SYNTHETIC_MARKET_CONFIG: MarketConfig = {
  market_margin_mode: 0,
  insurance_fund_account_index: 0,
  liquidation_mode: 0,
  force_reduce_only: false,
  trading_hours: '',
  rfq_enabled: false,
}

export function buildSyntheticPerpsEntry(
  symbol: string,
  marketId: number,
  backendSymbol = symbol,
): PerpsOrderBookDetail {
  return {
    symbol,
    backend_symbol: backendSymbol,
    market_id: marketId,
    market_type: 'perp',
    base_asset_id: -1,
    quote_asset_id: -1,
    status: 'inactive',
    taker_fee: '0',
    maker_fee: '0',
    liquidation_fee: '0',
    min_base_amount: '0',
    min_quote_amount: '0',
    order_quote_limit: '0',
    supported_size_decimals: 0,
    supported_price_decimals: 0,
    supported_quote_decimals: 0,
    size_decimals: 0,
    price_decimals: 0,
    display_size_decimals: 0,
    display_price_decimals: 0,
    quote_multiplier: 0,
    multiplier: '1',
    index_price: '0',
    mark_price: '0',
    default_initial_margin_fraction: 0,
    min_initial_margin_fraction: 0,
    maintenance_margin_fraction: 0,
    closeout_margin_fraction: 0,
    market_config: SYNTHETIC_MARKET_CONFIG,
    strategy_index: 0,
    is_taker_fee_enabled: false,
    is_maker_fee_enabled: false,
    funding_premium_multiplier: 1,
    funding_clamp_small: '0',
    funding_clamp_big: '0',
    base_interest_rate: '0',
    created_at: '',
    market_flags: 0,
  }
}

export function buildSyntheticSpotEntry(
  symbol: string,
  marketId: number,
  backendSymbol = symbol,
): SpotOrderBookDetail {
  return {
    symbol,
    backend_symbol: backendSymbol,
    market_id: marketId,
    market_type: 'spot',
    base_asset_id: -1,
    quote_asset_id: -1,
    status: 'inactive',
    taker_fee: '0',
    maker_fee: '0',
    liquidation_fee: '0',
    min_base_amount: '0',
    min_quote_amount: '0',
    order_quote_limit: '0',
    supported_size_decimals: 0,
    supported_price_decimals: 0,
    supported_quote_decimals: 0,
    size_decimals: 0,
    price_decimals: 0,
    display_size_decimals: 0,
    display_price_decimals: 0,
    is_taker_fee_enabled: false,
    is_maker_fee_enabled: false,
    multiplier: '1',
    created_at: '',
  }
}
