import type { WsPerpsMarketStats, WsSpotMarketStats } from '../lighter-ws/types/WsMessage'

export const getMarketDisplayPrice = (
  stats: WsSpotMarketStats | WsPerpsMarketStats | undefined,
): number => {
  const midPrice = stats?.mid_price ?? 0
  return midPrice > 0 ? midPrice : (stats?.last_trade_price ?? 0)
}
