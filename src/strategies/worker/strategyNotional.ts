import type { MarketDataSource, StrategyConfig, StrategyKind } from '../engine/types'

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** The quote a strategy trades if it fills in full: a buy priced at the best
 *  ask, a sell at the best bid, an iceberg buy at its limit price and an
 *  iceberg sell at the higher of its limit and the bid. Null without a price. */
export const estimateStrategyNotional = (
  kind: StrategyKind,
  config: StrategyConfig,
  marketData: MarketDataSource,
): number | null => {
  const { marketId } = config
  // An empty book side or a missing mid arrives as 0, so only a positive price counts.
  const marketPrice =
    [
      config.isAsk === 1
        ? marketData.getBestBidPrice(marketId)
        : marketData.getBestAskPrice(marketId),
      marketData.getMidPrice(marketId),
      marketData.getMarkPrice(marketId),
    ].find(isPositiveNumber) ?? null
  if (kind === 'iceberg' && 'limitPrice' in config) {
    // A sell's limit is only a floor: it fills at the book, or higher.
    if (config.isAsk !== 1) return config.totalSize * config.limitPrice
    return marketPrice === null ? null : config.totalSize * Math.max(config.limitPrice, marketPrice)
  }
  return marketPrice === null ? null : config.totalSize * marketPrice
}

/** Throws unless the fields the estimate reads are valid and the notional is
 *  at most `maxNotional`. */
export const assertStrategyNotional = (
  kind: StrategyKind,
  config: StrategyConfig,
  marketData: MarketDataSource,
  maxNotional: number,
): void => {
  if (!isPositiveNumber(config.totalSize)) {
    throw new Error('Strategy totalSize must be a positive number')
  }
  if (config.isAsk !== 0 && config.isAsk !== 1) throw new Error('Strategy isAsk must be 0 or 1')
  if (kind === 'iceberg' && !isPositiveNumber((config as { limitPrice?: unknown }).limitPrice)) {
    throw new Error('Iceberg limitPrice must be a positive number')
  }
  const notional = estimateStrategyNotional(kind, config, marketData)
  if (notional === null)
    throw new Error(`No price to estimate the notional of market ${config.marketId}`)
  if (!(notional <= maxNotional)) {
    throw new Error(
      `Strategy notional of about ${Math.round(notional)} exceeds the maximum of ${maxNotional}`,
    )
  }
}
