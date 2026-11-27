import { fetchCandlePage } from './fetchCandlePage'
import {
  candleToCandlestick,
  markPriceCandlesWithTradeVolume,
  obResToResInMiliseconds,
  mergeTradeAndMarkPriceCandles,
  tvResToObRes,
} from '../candlesticks'
import type { ExtendedCandlestick } from '../../store/orderbook/types'
import type { CandlestickApi } from 'zklighter-perps'
import type { CandlesRequest } from 'zklighter-perps/apis/CandlestickApi'

// Recovery fires the moment a socket reopens, often on a tab that has just
// woken and has no network yet. Live candles stay paused until it settles, so
// fail fast and let the retry land rather than hold the chart for a full page timeout.
const RECOVERY_PAGE_TIMEOUT_MS = 5_000

export function getRecoveryIntervalMs(resolution: string): number {
  const interval = obResToResInMiliseconds(tvResToObRes(resolution))
  if (!interval) throw new Error(`Unsupported candle resolution: ${resolution}`)
  return interval
}

/** Unlike getHistoricalCandlesticks, a failed page rejects the entire range. */
export async function fetchRecoveryCandles({
  api,
  marketId,
  resolution,
  from,
  to,
  showRawPrices,
  showMarkPriceCandles,
  signal,
}: {
  api: Pick<CandlestickApi, 'candles' | 'markPriceCandles'>
  marketId: number
  resolution: string
  from: number
  to: number
  showRawPrices: boolean
  showMarkPriceCandles: boolean
  signal: AbortSignal
}): Promise<ExtendedCandlestick[]> {
  const wsResolution = tvResToObRes(resolution)
  const interval = getRecoveryIntervalMs(resolution)
  const result: ExtendedCandlestick[] = []
  if (to <= from) return result
  // Continuity belongs to the subscriber, which owns the displayed predecessor.
  // Seeding here would retain wick extrema from a different REST predecessor.
  // Each window contains at most 499 bars (+ an inclusive right endpoint).
  // Walking time windows rather than count_back avoids silent truncation on
  // long outages and supports legitimate empty trading periods.
  for (let start = from; start < to; start += 499 * interval) {
    if (signal.aborted) throw new Error('Candle recovery aborted')
    const end = Math.min(to, start + 499 * interval)
    const params: CandlesRequest = {
      market_id: marketId,
      resolution: wsResolution,
      start_timestamp: start,
      end_timestamp: end,
      count_back: 500,
    }
    const [trade, mark] = await fetchCandlePage(
      signal,
      (pageSignal) =>
        Promise.all([
          api.candles(params, { signal: pageSignal }),
          showMarkPriceCandles || !showRawPrices
            ? api.markPriceCandles(params, { signal: pageSignal })
            : Promise.resolve(undefined),
        ] as const),
      RECOVERY_PAGE_TIMEOUT_MS,
    )
    if (trade.code !== 200 || (mark && mark.code !== 200)) {
      throw new Error(trade.message || mark?.message || 'Candle recovery failed')
    }
    let bars: ExtendedCandlestick[]
    if (showMarkPriceCandles) {
      bars = markPriceCandlesWithTradeVolume(mark!.c, trade.c, marketId, wsResolution)
    } else if (showRawPrices) {
      bars = trade.c.map((candle) => candleToCandlestick(candle, marketId, wsResolution, true))
    } else {
      bars = mergeTradeAndMarkPriceCandles(trade.c, mark!.c, marketId, wsResolution)
    }
    for (const bar of bars.sort((a, b) => a.time - b.time)) {
      if (bar.time >= start && bar.time < end) result.push(bar)
    }
  }
  return result
}

/** Preserve the cumulative range/volume without regressing trade snapshots. */
export function mergeRecoveryOverlap(
  snapshot: ExtendedCandlestick,
  live: ExtendedCandlestick,
  source: 'checkpoint' | 'buffered' = 'buffered',
  preserveMidPriceClose = false,
): ExtendedCandlestick {
  // Equal trade IDs include mid-price updates and mark-price candles (ID 0).
  // Buffered live closes win ties. A checkpoint predates REST, so only a strictly
  // newer trade ID can override its close (especially mark candles with ID 0).
  const newerTrade =
    source === 'checkpoint'
      ? live.lastTradeId > snapshot.lastTradeId ||
        (preserveMidPriceClose && live.lastTradeId === snapshot.lastTradeId)
      : live.lastTradeId >= snapshot.lastTradeId
  return {
    ...snapshot,
    close: newerTrade ? live.close : snapshot.close,
    lastTradeId: Math.max(snapshot.lastTradeId, live.lastTradeId),
    high: Math.max(snapshot.high, live.high),
    low: Math.min(snapshot.low, live.low),
    volume: Math.max(snapshot.volume ?? 0, live.volume ?? 0),
    volumeBase: Math.max(snapshot.volumeBase ?? 0, live.volumeBase ?? 0),
  }
}
