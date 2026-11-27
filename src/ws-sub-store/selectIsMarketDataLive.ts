import { isTestingEnvironment } from '../testing/isTestingEnvironment'

import { channelIsLoading } from './channels'
import type { WsSubStore } from './useWsSubStore'

const MARKET_DATA_CHANNELS = ['market_stats/all', 'spot_market_stats/all', 'bo_market_stats/all']

export const getMarketDataPongTimeoutMs = () => (isTestingEnvironment() ? 30_000 : 12_000)

export const selectIsMarketDataLive = ({
  ws,
  lastPingTime,
  lastPongTime,
  channels,
}: Pick<WsSubStore, 'ws' | 'lastPingTime' | 'lastPongTime' | 'channels'>) =>
  ws !== null &&
  !(
    lastPingTime !== null &&
    lastPongTime !== null &&
    lastPingTime - lastPongTime > getMarketDataPongTimeoutMs()
  ) &&
  !MARKET_DATA_CHANNELS.some((channel) => channelIsLoading(channels[channel]))
