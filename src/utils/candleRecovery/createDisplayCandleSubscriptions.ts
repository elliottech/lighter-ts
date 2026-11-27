import { wsChannelReconnectTimeout } from '../../lighter-ws/utils/wsChannelReconnectTimeout'
import type { ExtendedCandlestick } from '../../store/orderbook/types'
import { useWsSubStore } from '../../ws-sub-store/useWsSubStore'
import { fetchHistoricalCandlesticks, getCandleKey, tvResToResInMiliseconds } from '../candlesticks'
import { getCalendarCandleBucketTimeMs } from '../getCalendarCandleBucketTimeMs'
import {
  CandleHistoryCancelledError,
  EXHAUSTED_HISTORY_RETRY_MS,
  createCandleSubscriptions,
  reportCandleError,
} from './createCandleSubscriptions'

const getDisplayCandleBucket = (time: number, resolution: string): number => {
  if (resolution === '3D' || resolution === '1W' || resolution === '1M')
    return getCalendarCandleBucketTimeMs(time, resolution)
  const interval = tvResToResInMiliseconds(resolution)
  return interval ? Math.floor(time / interval) * interval : time
}

/** Aggregate source candles before TradingView applies its countBack cache slice. */
export const aggregateDisplayCandles = (
  bars: ExtendedCandlestick[],
  resolution: string,
): ExtendedCandlestick[] => {
  const buckets = new Map<number, ExtendedCandlestick>()
  // Source pages are ordered and unique. Realtime callers replace an existing
  // source candle before aggregating, so a tick never double-counts volume.
  for (const bar of bars) {
    const time = getDisplayCandleBucket(bar.time, resolution)
    const previous = buckets.get(time)
    buckets.set(
      time,
      previous
        ? {
            ...bar,
            time,
            open: previous.open,
            high: Math.max(previous.high, bar.high),
            low: Math.min(previous.low, bar.low),
            volume: (previous.volume ?? 0) + (bar.volume ?? 0),
            volumeBase: (previous.volumeBase ?? 0) + (bar.volumeBase ?? 0),
            lastTradeId: Math.max(previous.lastTradeId, bar.lastTradeId),
          }
        : { ...bar, time },
    )
  }
  return [...buckets.values()]
}

type HistoryParams = Parameters<typeof fetchHistoricalCandlesticks>[0]
const alignHistory = (params: HistoryParams): HistoryParams => {
  // Include complete first buckets (and a predecessor for continuous opens).
  // Months vary in length; 31 days is an upper bound, not a bucket definition.
  const duration =
    params.resolution === '1M' ? 31 * 86400000 : tvResToResInMiliseconds(params.resolution)
  const from = getDisplayCandleBucket(
    Math.min(
      params.period.from * 1000,
      params.period.to * 1000 - params.period.countBack * duration,
    ),
    params.resolution,
  )
  return {
    ...params,
    completeBoundary: true,
    strict: true,
    period: {
      ...params.period,
      from: getDisplayCandleBucket(from - 1, params.resolution) / 1000,
      countBack: params.period.countBack + 1,
    },
  }
}

/** Opt-in display aggregation. Existing native/KLine source consumers are unchanged. */
export const createDisplayCandleSubscriptions = (
  ...args: Parameters<typeof createCandleSubscriptions>
) => {
  let disposed = false
  const historyControllers = new Set<AbortController>()
  const abortHistory = () => {
    for (const controller of historyControllers) controller.abort()
    historyControllers.clear()
  }
  const streams = createCandleSubscriptions(args[0], {
    ...args[1],
    onHistoryInvalidated: () => {
      abortHistory()
      args[1]?.onHistoryInvalidated?.()
    },
  })
  // Pending pagination waits for a socket like initial history. Reconnect and
  // refresh resume it (during a wait or an in-flight attempt) and rearm the
  // fast cycle; a page whose owner left is pruned even without a socket.
  type PendingPage = { owned: () => boolean; cancel: () => void; resume: () => void }
  const pendingPages = new Set<PendingPage>()
  const prunePagination = () => {
    for (const page of pendingPages) if (!page.owned()) page.cancel()
  }
  const resumePagination = () => {
    prunePagination()
    if (useWsSubStore.getState().ws) for (const page of pendingPages) page.resume()
  }
  const unsubscribeConnection = useWsSubStore.subscribe((next, previous) => {
    if (next.ws !== previous.ws) resumePagination()
  })
  const waitBeforeRetry = (delayMs: number | undefined, signal: AbortSignal) => {
    let wake = () => {}
    const waited = new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      wake = () => {
        cleanup()
        resolve(true)
      }
      const onAbort = () => {
        cleanup()
        reject(new CandleHistoryCancelledError())
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      if (useWsSubStore.getState().ws)
        timer = setTimeout(() => {
          // Disconnected during the backoff: keep waiting for the reconnect wake.
          if (!useWsSubStore.getState().ws) return
          cleanup()
          resolve(false)
        }, delayMs)
    })
    return { waited, wake: () => wake() }
  }
  const seeds = new Map<string, ExtendedCandlestick[]>()
  const updateSeed = (key: string, resolution: string, source: ExtendedCandlestick[]) => {
    const last = source.at(-1)
    if (!last) return
    const previous = seeds.get(key)
    if (previous && previous.at(-1)!.time > last.time) return
    const bucket = getDisplayCandleBucket(last.time, resolution)
    // Preserve known constituents when a joining listener has only a partial
    // same-bucket source; equal-time updates replace values, not volume twice.
    const merged = new Map(
      (previous ?? [])
        .filter((bar) => getDisplayCandleBucket(bar.time, resolution) === bucket)
        .map((bar) => [bar.time, bar]),
    )
    for (const bar of source) merged.set(bar.time, bar)
    seeds.set(
      key,
      [...merged.values()].sort((a, b) => a.time - b.time),
    )
  }
  const listeners = new Map<string, string>()
  let generation = streams.generation
  const syncGeneration = () => {
    if (generation !== streams.generation) {
      seeds.clear()
      generation = streams.generation
    }
  }
  return {
    ...streams,
    get generation() {
      return streams.generation
    },
    fetchInitialHistory: (params: HistoryParams) =>
      streams.fetchInitialHistory(alignHistory(params)),
    refresh() {
      streams.refresh()
      resumePagination()
    },
    fetchHistory: async (params: HistoryParams) => {
      if (disposed) throw new CandleHistoryCancelledError()
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (params.signal?.aborted) abort()
      else params.signal?.addEventListener('abort', abort, { once: true })
      historyControllers.add(controller)
      const ownsHistory = args[1]?.getHistoryOwner?.(params)
      const owned = () => ownsHistory?.() !== false && args[1]?.isHistoryActive?.(params) !== false
      const aligned = alignHistory(params)
      const request: HistoryParams = {
        ...aligned,
        // REST end_timestamp is inclusive; TradingView's history end is exclusive.
        // Exclude the bucket owned by the next page, not just duplicate timestamps.
        period: {
          ...aligned.period,
          to: (getDisplayCandleBucket(params.period.to * 1000, params.resolution) - 1) / 1000,
        },
        signal: controller.signal,
      }
      let failures = 0
      let resumed = false
      let wake: (() => void) | undefined
      const page: PendingPage = {
        owned,
        cancel: abort,
        resume: () => {
          if (wake) wake()
          else resumed = true
        },
      }
      pendingPages.add(page)
      try {
        for (;;) {
          if (controller.signal.aborted || !owned()) throw new CandleHistoryCancelledError()
          resumed = false
          try {
            const bars = await fetchHistoricalCandlesticks(request)
            if (controller.signal.aborted || !owned()) throw new CandleHistoryCancelledError()
            return bars
          } catch (error) {
            if (controller.signal.aborted || !owned()) throw new CandleHistoryCancelledError()
            // TradingView caches a page error per dataset and drops the pane's
            // realtime subscription, so keep its request pending and retry with
            // the initial-history cycle instead of returning a terminal error.
            failures = resumed ? 0 : failures + 1
            if (failures === 5 && useWsSubStore.getState().ws)
              reportCandleError(error, 'pagination')
            const wait = waitBeforeRetry(
              resumed
                ? 0
                : failures < 5
                  ? wsChannelReconnectTimeout(failures)
                  : EXHAUSTED_HISTORY_RETRY_MS,
              controller.signal,
            )
            wake = wait.wake
            try {
              if (await wait.waited) failures = 0
            } finally {
              wake = undefined
            }
          }
        }
      } finally {
        pendingPages.delete(page)
        historyControllers.delete(controller)
        params.signal?.removeEventListener('abort', abort)
      }
    },
    prepareHistory(
      marketId: number,
      resolution: string,
      bars: ExtendedCandlestick[],
      initial: boolean,
    ) {
      if (disposed) return []
      syncGeneration()
      if (initial) {
        const key = getCandleKey(marketId, resolution)
        const last = bars.at(-1)
        if (last) {
          const bucket = getDisplayCandleBucket(last.time, resolution)
          updateSeed(
            key,
            resolution,
            bars.filter((bar) => getDisplayCandleBucket(bar.time, resolution) === bucket),
          )
        }
        streams.setHistory(marketId, resolution, last)
      }
      return aggregateDisplayCandles(bars, resolution)
    },
    subscribe(params: Parameters<typeof streams.subscribe>[0]) {
      if (disposed) return
      syncGeneration()
      const key = getCandleKey(params.marketId, params.resolution)
      let source: ExtendedCandlestick[] | undefined = seeds.has(key)
        ? [...(seeds.get(key) ?? [])]
        : undefined
      let localGeneration = generation
      const replacedKey = listeners.get(params.listenerGuid)
      listeners.set(params.listenerGuid, key)
      if (replacedKey && replacedKey !== key && ![...listeners.values()].includes(replacedKey))
        seeds.delete(replacedKey)
      streams.subscribe({
        ...params,
        onRealtimeCallback: (bar) => {
          if (disposed) return
          syncGeneration()
          if (localGeneration !== generation) {
            source = undefined
            localGeneration = generation
          }
          source ??= [...(seeds.get(key) ?? [])]
          const bucket = getDisplayCandleBucket(bar.time, params.resolution)
          source = source.filter(
            (b) =>
              getDisplayCandleBucket(b.time, params.resolution) === bucket && b.time !== bar.time,
          )
          source.push(bar)
          source.sort((a, b) => a.time - b.time)
          updateSeed(key, params.resolution, source)
          const display = aggregateDisplayCandles(source, params.resolution)[0]
          if (display) params.onRealtimeCallback(display)
        },
      })
    },
    unsubscribe(guid: string) {
      const key = listeners.get(guid)
      listeners.delete(guid)
      streams.unsubscribe(guid)
      if (key && ![...listeners.values()].includes(key)) seeds.delete(key)
      prunePagination()
    },
    clear() {
      streams.clear()
      seeds.clear()
      listeners.clear()
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeConnection()
      streams.dispose()
      abortHistory()
      seeds.clear()
      listeners.clear()
    },
  }
}
