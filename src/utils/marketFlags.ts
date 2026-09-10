import type { OrderBookDetail } from '../types/compatibility'
import { MarginMode } from '../types/MarginMode'

import { isMarketSpot } from './common'

export const getDefaultMarketMarginModeFromFlags = (marketFlags = 0) =>
  marketFlags === 0 || marketFlags === 1 ? MarginMode.CROSS : MarginMode.ISOLATED

const getMarketMarginModeFromFlags = (marketFlags = 0) =>
  marketFlags === 0 || marketFlags === 2 ? MarginMode.CROSS : MarginMode.ISOLATED

export const isMarketIsolatedOnly = (market: OrderBookDetail) =>
  isMarketSpot(market)
    ? false
    : market.market_config.market_margin_mode === MarginMode.ISOLATED ||
      getMarketMarginModeFromFlags(market.market_flags) === MarginMode.ISOLATED
