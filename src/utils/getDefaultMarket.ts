import { isHiddenMarket } from '../store/orderbook/selectors'
import type { PerpsOrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'

export const getDefaultMarket = <T extends SpotOrderBookDetail | PerpsOrderBookDetail>(
  markets: T[],
  preferredSymbols: string[],
): T | undefined => {
  const visibleMarkets = markets.filter((market) => !isHiddenMarket(market))
  const candidates = visibleMarkets.length > 0 ? visibleMarkets : markets

  for (const symbol of preferredSymbols) {
    const market = candidates.find(
      (market) => market.symbol === symbol || market.symbol.replace('/', '_') === symbol,
    )
    if (market) {
      return market
    }
  }

  return candidates[0]
}
