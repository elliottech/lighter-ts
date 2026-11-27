import { MarketConfigMarketMarginModeEnum, AccountPositionMarginModeEnum } from 'zklighter-perps'

import type { OrderBookDetail } from '../types/compatibility'

import { isMarketSpot } from './common'

export const getDefaultMarketMarginModeFromFlags = (marketFlags = 0) =>
  marketFlags === 0 || marketFlags === 1
    ? AccountPositionMarginModeEnum.Cross
    : AccountPositionMarginModeEnum.Isolated

const getMarketMarginModeFromFlags = (marketFlags = 0) =>
  marketFlags === 0 || marketFlags === 2
    ? AccountPositionMarginModeEnum.Cross
    : AccountPositionMarginModeEnum.Isolated

export const isMarketIsolatedOnly = (market: OrderBookDetail) =>
  isMarketSpot(market)
    ? false
    : market.market_config?.market_margin_mode ===
        MarketConfigMarketMarginModeEnum.IsolatedForNonPools ||
      getMarketMarginModeFromFlags(market.market_flags) === AccountPositionMarginModeEnum.Isolated
