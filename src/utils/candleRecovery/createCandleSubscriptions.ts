import { wsChannelReconnectTimeout } from '../../lighter-ws/utils/wsChannelReconnectTimeout'
import type { ExtendedCandlestick } from '../../store/orderbook/types'
import type { LighterStoreWithSubscribe } from '../../store/useLighterStore'
import { selectNewCandlesticks, selectOrderBookMeta } from '../../store/orderbook/selectors'
import { useWsSubStore } from '../../ws-sub-store/useWsSubStore'
import { apis } from '../../lib/apis'
import { errorReporting } from '../../lib/errorReporting'
import { realCandlesticksToDisplay } from '../multiplier'
import {
  fetchHistoricalCandlesticks,
  getCandleKey,
  tvResToObRes,
  withContinuousOpen,
  withPreviousRange,
} from '../candlesticks'
import { createCandleRecovery } from './createCandleRecovery'
import {
  fetchRecoveryCandles,
  getRecoveryIntervalMs,
  mergeRecoveryOverlap,
} from './fetchRecoveryCandles'

type SubscribeStreamParams = {
  marketId: number
  resolution: string
  onRealtimeCallback: (candlestick: ExtendedCandlestick) => void
  listenerGuid: string
  waitForHistory?: boolean
}

export const EXHAUSTED_HISTORY_RETRY_MS = 60_000

const isTransientStatus = (status: number | undefined) =>
  status !== undefined && (status === 429 || status >= 500)

// Timeouts, dropped connections and upstream 429/5xx are the client's network
// or an upstream limit, not a defect: retries heal them, so they are not reported.
const isTransientCandleError = (error: unknown) =>
  error instanceof Error &&
  (error.name === 'TimeoutError' ||
    error.name === 'FetchError' ||
    (error.name === 'ResponseError' &&
      isTransientStatus((error as { response?: { status?: number } }).response?.status)))

export const reportCandleError = (error: unknown, path: 'initial' | 'recovery' | 'pagination') => {
  if (isTransientCandleError(error)) return
  errorReporting.captureException(error, { tags: { candle_path: path } })
}

// Cancellation is an expected lifecycle outcome, not a failed history request.
export class CandleHistoryCancelledError extends Error {
  constructor(readonly reason: 'cancelled' | 'superseded' = 'cancelled') {
    super('Candle history cancelled')
    this.name = 'CandleHistoryCancelledError'
  }
}

// Scoped to the datafeed/widget, rather than sharing listeners across mounts.
// A manager without isHistoryActive belongs to one chart. Widgets with overlapping
// chart lifetimes must provide the guard: realtime subscriptions cannot identify
// ownership of a different chart's pending initial request.
export const createCandleSubscriptions = (
  store: LighterStoreWithSubscribe,
  options: {
    onHistoryInvalidated?: () => void
    getHistoryOwnerKeys?: (params: { marketId: number; resolution: string }) => string[]
    onInitialHistoryError?: (
      params: { marketId: number; resolution: string },
      error: unknown,
    ) => void
    onInitialHistorySuccess?: (params: { marketId: number; resolution: string }) => void
    isHistoryActive?: (params: { marketId: number; resolution: string }) => boolean
    // Capture the owning consumer lifetime once; retries must not adopt a replacement view.
    getHistoryOwner?: (params: { marketId: number; resolution: string }) => () => boolean
  } = {},
) => {
  const lastCandlesticks = new Map<string, ExtendedCandlestick>()
  const subscriptions = new Map<
    string,
    {
      key: string
      recovery: ReturnType<typeof createCandleRecovery<ExtendedCandlestick>>
      setHistory: (bar: ExtendedCandlestick | undefined) => void
      dispose: () => void
    }
  >()
  // Initial history must succeed before live ticks can stand in for it. Keep the
  // original consumer request pending across outages, including before TV subscribes.
  const initialRequests = new Map<
    string,
    {
      key: string
      params: { marketId: number; resolution: string }
      isOwned: () => boolean
      callers: Set<{
        ownerKeys: Set<string>
        isOwned: () => boolean
        cancel: () => void
      }>
      ownerKeys: Set<string>
      promise: Promise<ExtendedCandlestick[]>
      resume: () => void
      cancel: (reason?: 'cancelled' | 'superseded') => void
    }
  >()
  const cancelInitialRequests = () => {
    for (const request of initialRequests.values()) request.cancel()
    initialRequests.clear()
  }
  const pruneInitialHistory = () => {
    for (const request of initialRequests.values()) {
      for (const caller of request.callers) if (!caller.isOwned()) caller.cancel()
      if (!request.callers.size) request.cancel()
    }
  }
  let connectionGeneration = 0
  let historyGeneration = 0
  let disposed = false
  // One synchronous connection listener per manager, regardless of chart count.
  const unsubConnection = useWsSubStore.subscribe((next, previous) => {
    if (next.ws === previous.ws) return
    pruneInitialHistory()
    connectionGeneration++
    for (const subscription of subscriptions.values()) subscription.recovery.setConnected(!!next.ws)
    if (next.ws) for (const request of initialRequests.values()) request.resume()
  })

  const updateSharedCheckpoint = (key: string, bar: ExtendedCandlestick) => {
    const previous = lastCandlesticks.get(key)
    if (!previous || bar.time >= previous.time) lastCandlesticks.set(key, { ...bar })
  }

  const resetHistory = () => {
    if (disposed) return
    historyGeneration++
    options.onHistoryInvalidated?.()
    cancelInitialRequests()
    lastCandlesticks.clear()
    for (const subscription of subscriptions.values()) subscription.recovery.resetHistory()
  }
  // Invalidate before React effects run, so old-mode requests/WS messages
  // cannot race a preference change and write prices into the new chart.
  const unsubPreferences = store.subscribe(
    (state) => `${state.preferences.showRawPrices}/${state.preferences.showMarkPriceCandles}`,
    resetHistory,
  )

  const unsubscribe = (guid: string, replacing = false) => {
    const subscription = subscriptions.get(guid)
    subscription?.dispose()
    subscriptions.delete(guid)
    // Without widget ownership information, the last explicit unsubscribe ends
    // this dataset's pending load. A replacement is not an abandoned chart.
    if (subscription && !replacing && !options.isHistoryActive) {
      const stillUsed = [...subscriptions.values()].some(({ key }) => key === subscription.key)
      if (!stillUsed)
        for (const request of initialRequests.values())
          if (request.key === subscription.key) request.cancel()
    }
    pruneInitialHistory()
  }

  const subscribe = ({
    marketId,
    resolution,
    onRealtimeCallback,
    listenerGuid,
    waitForHistory,
  }: SubscribeStreamParams) => {
    if (disposed) return
    const key = getCandleKey(marketId, resolution)
    const wsResolution = tvResToObRes(resolution)
    const intervalMs = getRecoveryIntervalMs(resolution)
    const replacingSameKey = subscriptions.get(listenerGuid)?.key === key
    // Acquire first: replacing the sole listener must not drop the shared wire
    // count to zero, clear its buffer, and create an unrecovered channel gap.
    if (replacingSameKey) useWsSubStore.getState().actions.subscribeCandle(marketId, wsResolution)
    unsubscribe(listenerGuid, replacingSameKey)
    // Keep a subscriber-local checkpoint: one chart must not advance another
    // chart's recovery cursor before its callback has received those candles.
    let last = lastCandlesticks.get(key)
    let callbackFailed = false
    const recovery = createCandleRecovery<ExtendedCandlestick>({
      initialBar: last,
      waitForHistory,
      intervalMs,
      connected: !!useWsSubStore.getState().ws,
      fetchBars: async (from, to, signal) => {
        const state = store.getState()
        const market = selectOrderBookMeta(state, { marketId })
        if (!market) throw new Error(`Missing candle market: ${marketId}`)
        const candles = await fetchRecoveryCandles({
          api: apis.candlesticksApi,
          marketId,
          resolution,
          from,
          to,
          signal,
          showRawPrices: state.preferences.showRawPrices,
          showMarkPriceCandles: state.preferences.showMarkPriceCandles,
        })
        return realCandlesticksToDisplay(candles, market)
      },
      emit: (bar, historical) => {
        // Historical OHLC replaces stale live extrema. Live updates still
        // preserve the accumulated range as before.
        const ranged = historical ? bar : withPreviousRange(bar, last)
        const display =
          store.getState().preferences.showRawPrices &&
          !store.getState().preferences.showMarkPriceCandles
            ? ranged
            : withContinuousOpen(ranged, last)
        last = { ...display }
        updateSharedCheckpoint(key, last)
        // Advance the attempted-delivery checkpoint even if this chart fails:
        // retrying its callback must not block other subscribers or replay forever.
        try {
          onRealtimeCallback(display)
          callbackFailed = false
        } catch (error) {
          if (!callbackFailed) errorReporting.captureException(error)
          callbackFailed = true
        }
        return last
      },
      mergeOverlap: (snapshot, live, source) => {
        const { showMarkPriceCandles } = store.getState().preferences
        // Trade-price WS closes (including raw mode) include mid-price updates absent from REST;
        // equal trade IDs therefore do not make that checkpoint close stale.
        return mergeRecoveryOverlap(snapshot, live, source, !showMarkPriceCandles)
      },
      onError: (error) => reportCandleError(error, 'recovery'),
    })
    const unsubStore = store.subscribe(
      (state) => selectNewCandlesticks(state, { marketId, resolution: wsResolution }),
      (candlesticks) => {
        const market = selectOrderBookMeta(store.getState(), { marketId })
        if (!candlesticks || !market) return
        for (const candle of realCandlesticksToDisplay(candlesticks, market)) {
          if (candle.marketId === marketId && candle.resolution === wsResolution) {
            recovery.push(candle)
          }
        }
      },
    )
    if (!replacingSameKey) useWsSubStore.getState().actions.subscribeCandle(marketId, wsResolution)
    subscriptions.set(listenerGuid, {
      key,
      recovery,
      setHistory: (bar) => {
        last = bar ? { ...bar } : undefined
        recovery.setHistory(bar)
      },
      dispose: () => {
        recovery.dispose()
        unsubStore()
        useWsSubStore.getState().actions.unsubscribeCandle(marketId, wsResolution)
      },
    })
  }

  const clear = () => {
    historyGeneration++
    options.onHistoryInvalidated?.()
    cancelInitialRequests()
    for (const guid of subscriptions.keys()) unsubscribe(guid)
    lastCandlesticks.clear()
  }

  const fetchInitialHistory = (
    params: Parameters<typeof fetchHistoricalCandlesticks>[0],
  ): Promise<ExtendedCandlestick[]> => {
    if (disposed) return Promise.reject(new CandleHistoryCancelledError())
    const key = getCandleKey(params.marketId, params.resolution)
    pruneInitialHistory()
    // Different initial windows are independent. Identical requests share the
    // fetch, but each chart gets its own mutable candle objects.
    const requestKey = JSON.stringify([
      key,
      params.period,
      params.showRawPrices,
      params.showMarkPriceCandles,
      params.completeBoundary,
    ])
    const copy = (bars: ExtendedCandlestick[]) => bars.map((bar) => ({ ...bar }))
    // Capture every caller before deduplication: a sibling can still own the
    // shared request after the first caller changes market or is removed.
    const ownsHistory = options.getHistoryOwner?.(params)
    const owner = () => ownsHistory?.() !== false && options.isHistoryActive?.(params) !== false
    const ownerKeys = new Set(options.getHistoryOwnerKeys?.(params))
    // A replacement request for this exact consumer/dataset supersedes its old
    // window. Different owners and unscoped historical windows stay independent.
    if (ownerKeys.size) {
      for (const [otherKey, request] of initialRequests) {
        if (
          otherKey !== requestKey &&
          request.key === key &&
          request.ownerKeys.size === ownerKeys.size &&
          [...ownerKeys].every((owner) => request.ownerKeys.has(owner))
        )
          request.cancel('superseded')
      }
    }
    const attachCaller = (request: NonNullable<ReturnType<typeof initialRequests.get>>) =>
      new Promise<ExtendedCandlestick[]>((resolve, reject) => {
        let settled = false
        const finishCaller = () => {
          settled = true
          request.callers.delete(caller)
        }
        const caller = {
          ownerKeys,
          isOwned: owner,
          cancel: () => {
            if (settled) return
            finishCaller()
            reject(new CandleHistoryCancelledError())
          },
        }
        request.callers.add(caller)
        void request.promise.then(
          (bars) => {
            if (settled) return
            if (!owner()) {
              caller.cancel()
              return
            }
            finishCaller()
            resolve(copy(bars))
          },
          (error: unknown) => {
            if (settled) return
            finishCaller()
            reject(error)
          },
        )
      })
    const existing = initialRequests.get(requestKey)
    if (existing) return attachCaller(existing)
    const callers: NonNullable<ReturnType<typeof initialRequests.get>>['callers'] = new Set()
    // Only a live-edge window follows the clock on retry. Explicit historical
    // windows keep their original bounds even if reused by a future consumer.
    const isOwned = () => [...callers].some((caller) => caller.isOwned())
    const followsLiveEdge =
      params.period.to >=
      Math.floor(Date.now() / 1000) - getRecoveryIntervalMs(params.resolution) / 1000
    let start = () => {}
    let resume = () => {}
    let cancel: (reason?: 'cancelled' | 'superseded') => void = () => {}
    const promise = new Promise<ExtendedCandlestick[]>((resolve, reject) => {
      let done = false
      let running = false
      let failures = 0
      let attempted = false
      let resumeRequested = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let controller: AbortController | undefined
      const finish = () => {
        done = true
        clearTimeout(timer)
        controller?.abort()
        initialRequests.delete(requestKey)
      }
      const run = async () => {
        if (done || running) return
        if (!isOwned()) {
          cancel()
          return
        }
        clearTimeout(timer)
        running = true
        const connection = connectionGeneration
        controller = new AbortController()
        try {
          // Retry the full initial window, advancing it through the outage.
          const to =
            attempted && followsLiveEdge
              ? Math.max(params.period.to, Math.floor(Date.now() / 1000))
              : params.period.to
          attempted = true
          const bars = await fetchHistoricalCandlesticks({
            ...params,
            period: { ...params.period, to, from: params.period.from + to - params.period.to },
            strict: true,
            signal: controller.signal,
          })
          if (done) return
          finish()
          resolve(bars)
          options.onInitialHistorySuccess?.(params)
        } catch (error) {
          if (done) return
          controller.abort()
          const resumed = resumeRequested || connection !== connectionGeneration
          resumeRequested = false
          failures = resumed ? 0 : failures + 1
          // Report the exhausted cycle, not each transient failure that then heals.
          if (
            failures === 5 &&
            useWsSubStore.getState().ws &&
            !(error instanceof Error && error.name === 'AbortError')
          )
            reportCandleError(error, 'initial')
          if (failures === 5) options.onInitialHistoryError?.(params, error)
          // After the bounded cycle the consumer shows its error state, but keep
          // trying slowly while online: a chart must not stay empty until the
          // user finds Retry once REST is reachable again.
          if (useWsSubStore.getState().ws)
            timer = setTimeout(
              () => void run(),
              resumed
                ? 0
                : failures < 5
                  ? wsChannelReconnectTimeout(failures)
                  : EXHAUSTED_HISTORY_RETRY_MS,
            )
        } finally {
          running = false
        }
      }
      resume = () => {
        if (done) return
        if (running) resumeRequested = true
        else {
          failures = 0
          void run()
        }
      }
      cancel = (reason) => {
        if (done) return
        finish()
        reject(new CandleHistoryCancelledError(reason))
      }
      start = () => void run()
    })
    const request = {
      key,
      params,
      isOwned,
      callers,
      get ownerKeys() {
        return new Set([...callers].flatMap((caller) => [...caller.ownerKeys]))
      },
      promise,
      resume,
      cancel,
    }
    initialRequests.set(requestKey, request)
    const result = attachCaller(request)
    start()
    return result
  }

  return {
    fetchInitialHistory,
    cancelInitialHistory(matchesOwner?: (key: string) => boolean) {
      let count = 0
      for (const request of initialRequests.values()) {
        if (!matchesOwner) {
          request.cancel()
          count++
          continue
        }
        let affected = false
        for (const caller of request.callers) {
          const selected = [...caller.ownerKeys].filter(matchesOwner)
          if (!selected.length) continue
          affected = true
          for (const key of selected) caller.ownerKeys.delete(key)
          // Release only this caller; its sibling keeps the shared transport.
          if (!caller.ownerKeys.size) caller.cancel()
        }
        if (affected) count++
        if (!request.callers.size) request.cancel()
      }
      return count
    },
    subscribe,
    unsubscribe: (guid: string) => unsubscribe(guid),
    clear,
    get generation() {
      return historyGeneration
    },
    setHistory(marketId: number, resolution: string, bar: ExtendedCandlestick | undefined) {
      if (disposed) return
      const key = getCandleKey(marketId, resolution)
      if (bar) updateSharedCheckpoint(key, bar)
      for (const subscription of subscriptions.values()) {
        if (subscription.key === key && subscription.recovery.needsHistory)
          subscription.setHistory(bar)
      }
    },
    resetHistory,
    // Foreground/resume can miss candles even when the socket stays connected.
    refresh() {
      pruneInitialHistory()
      if (useWsSubStore.getState().ws)
        for (const request of initialRequests.values()) request.resume()
      for (const subscription of subscriptions.values()) {
        subscription.recovery.setConnected(!!useWsSubStore.getState().ws)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubPreferences()
      unsubConnection()
      clear()
    },
  }
}
