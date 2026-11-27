import { apis } from '../../lib/apis'
import { wsChannelReconnectTimeout } from '../../lighter-ws/utils/wsChannelReconnectTimeout'
import { selectUpDownCandles } from '../../store/orderbook/selectors'
import { useLighterStore } from '../../store/useLighterStore'
import {
  UP_DOWN_RESOLUTION_SECONDS,
  type UpDownPriceCandle,
  type UpDownResolution,
  formatUpDownDuration,
  upsertUpDownCandles,
} from '../../ws-sub-store/upDownPrice'
import { useWsSubStore } from '../../ws-sub-store/useWsSubStore'
import { createCandleRecovery } from '../candleRecovery/createCandleRecovery'
import { reportCandleError } from '../candleRecovery/createCandleSubscriptions'
import { fetchCandlePage } from '../candleRecovery/fetchCandlePage'

export interface UpDownSeriesWindow {
  symbol: string
  /** Seconds. Selects the backend series; every duration of a symbol shares one price feed. */
  duration: number
  /** Any span of the feed, usually one event's window. */
  startAt: number
  endAt: number
}

export interface UpDownSeriesState {
  /** Ascending, clamped to the window plus a short lead-in before `startAt`. */
  candles: UpDownPriceCandle[]
  resolution: UpDownResolution
  /** The window has begun and its history has not loaded yet. */
  isLoading: boolean
  /** Every candle up to and including `endAt` is loaded and will not change. */
  isComplete: boolean
}

const UP_DOWN_PAGE_LIMIT = 3_600
const UP_DOWN_MAX_RANGE_SECONDS = 86_400
const UP_DOWN_PAGE_TIMEOUT_MS = 10_000
// Covers the backend's fallback to the last observation before a boundary second.
const UP_DOWN_LEAD_IN_SECONDS = 10
// The settlement observation (at `endAt`) can land a moment after the boundary.
const UP_DOWN_SETTLE_GRACE_MS = 5_000
const UP_DOWN_MIN_RECOVERY_INTERVAL_SECONDS = 30
// The backend settles a skipped boundary second once an observation within a minute follows it.
export const UP_DOWN_BOUNDARY_LOOKAHEAD_SECONDS = 60
const UP_DOWN_FINAL_POLL_MS = 3_000
const UP_DOWN_FINAL_DEADLINE_MS = 120_000
const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** `1s` candles for windows up to an hour, `30s` beyond so a long window stays a few pages. */
export const getUpDownSeriesResolution = (windowMs: number): UpDownResolution =>
  windowMs <= 3_600_000 ? '1s' : '30s'

export const fetchUpDownCandles = async ({
  symbol,
  duration,
  resolution,
  from,
  to,
  signal,
}: {
  symbol: string
  duration: number
  resolution: UpDownResolution
  /** Inclusive unix seconds. */
  from: number
  to: number
  signal?: AbortSignal
}): Promise<UpDownPriceCandle[]> => {
  const candles: UpDownPriceCandle[] = []
  let cursor = from
  while (cursor <= to) {
    const end = Math.min(to, cursor + UP_DOWN_MAX_RANGE_SECONDS)
    const response = await fetchCandlePage(
      signal,
      (pageSignal) =>
        apis.updownApi.upDownCandles(
          {
            symbol: symbol.toLowerCase(),
            duration: formatUpDownDuration(duration),
            resolution,
            start_timestamp: cursor,
            end_timestamp: end,
            limit: UP_DOWN_PAGE_LIMIT,
          },
          { signal: pageSignal },
        ),
      UP_DOWN_PAGE_TIMEOUT_MS,
    )
    if (response.code !== 200) throw new Error(response.message || 'Up/down candles failed')
    for (const candle of response.candles) {
      candles.push({
        timestamp: candle.timestamp,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
      })
    }
    const next = response.next_cursor
    cursor = next !== undefined && next > cursor && next <= end ? next : end + 1
  }
  return candles
}

type UpDownBar = UpDownPriceCandle & { time: number }

const toBar = (candle: UpDownPriceCandle): UpDownBar => ({
  ...candle,
  time: candle.timestamp * 1_000,
})

const fromBar = ({ timestamp, open, high, low, close }: UpDownBar): UpDownPriceCandle => ({
  timestamp,
  open,
  high,
  low,
  close,
})

const isSameCandle = (a: UpDownPriceCandle, b: UpDownPriceCandle) =>
  a.timestamp === b.timestamp &&
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close

const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError'

/**
 * Loads one up/down window: nothing before it opens, REST history plus the live feed while it
 * runs (recovering gaps on reconnect and `refresh`), and the final REST window once it ends.
 */
export const createUpDownSeries = ({ symbol, duration, startAt, endAt }: UpDownSeriesWindow) => {
  const resolution = getUpDownSeriesResolution(endAt - startAt)
  const stepSeconds = UP_DOWN_RESOLUTION_SECONDS[resolution]
  // At least one bucket before the start, for the price the backend falls back to.
  const fromSeconds = Math.floor(startAt / 1_000) - Math.max(UP_DOWN_LEAD_IN_SECONDS, stepSeconds)
  const endSeconds = Math.floor(endAt / 1_000)
  const listeners = new Set<() => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let state: UpDownSeriesState = {
    candles: [],
    resolution,
    isLoading: Date.now() >= fromSeconds * 1_000,
    isComplete: false,
  }
  let disposed = false
  let stopLive: (() => void) | undefined
  let retryPending: (() => void) | undefined

  const setState = (patch: Partial<UpDownSeriesState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const addCandles = (candles: UpDownPriceCandle[]) => {
    const inWindow = candles.flatMap((candle) => {
      if (candle.timestamp < fromSeconds || candle.timestamp > endSeconds) return []
      // Only the observation at the end second belongs to the window; a coarser bucket that
      // starts there keeps growing after it.
      if (candle.timestamp < endSeconds) return [candle]
      const { open } = candle
      return [{ timestamp: candle.timestamp, open, high: open, low: open, close: open }]
    })
    if (inWindow.length > 0) setState({ candles: upsertUpDownCandles(state.candles, inWindow) })
  }

  const schedule = (run: () => void, delayMs: number) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer)
        if (!disposed) run()
      },
      // Longer delays overflow setTimeout and fire at once.
      Math.min(delayMs, MAX_TIMEOUT_MS),
    )
    timers.add(timer)
    return timer
  }

  const fetchRange = (from: number, to: number, signal?: AbortSignal) =>
    fetchUpDownCandles({ symbol, duration, resolution, from, to, signal })

  // Retries while the socket is up and parks while it is down: a reconnect or `refresh` resumes.
  const withRetry = (run: (signal: AbortSignal) => Promise<void>) => {
    let failures = 0
    let controller: AbortController | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      retryPending = undefined
      clearTimeout(retryTimer)
      timers.delete(retryTimer!)
      controller?.abort()
      const current = new AbortController()
      controller = current
      run(current.signal).catch((error: unknown) => {
        if (disposed || current.signal.aborted || isAbort(error)) return
        failures++
        if (failures === 5) reportCandleError(error, 'initial')
        retryPending = attempt
        if (useWsSubStore.getState().ws)
          retryTimer = schedule(attempt, wsChannelReconnectTimeout(failures) ?? 15_000)
      })
    }
    attempt()
    return () => {
      controller?.abort()
      clearTimeout(retryTimer)
      if (retryPending === attempt) retryPending = undefined
    }
  }

  const loadFinal = (): (() => void) =>
    withRetry(async (signal) => {
      const candles = await fetchRange(
        fromSeconds,
        endSeconds + UP_DOWN_BOUNDARY_LOOKAHEAD_SECONDS,
        signal,
      )
      if (disposed || signal.aborted) return
      addCandles(candles)
      // Until REST holds an observation at or after the end, the window may still be missing
      // its last candles.
      const caughtUp = (candles.at(-1)?.timestamp ?? Number.NEGATIVE_INFINITY) >= endSeconds
      if (!caughtUp && Date.now() < endAt + UP_DOWN_FINAL_DEADLINE_MS) {
        setState({ isLoading: false })
        schedule(() => {
          cancelFinal = loadFinal()
        }, UP_DOWN_FINAL_POLL_MS)
        return
      }
      setState({ isLoading: false, isComplete: true })
    })

  const startLive = () => {
    const { actions } = useWsSubStore.getState()
    actions.subscribeUpDownPrice(symbol, duration, resolution)

    const recovery = createCandleRecovery<UpDownBar>({
      waitForHistory: true,
      connected: !!useWsSubStore.getState().ws,
      // Recovery refetches when an interval closes mid-request; a 1s candle is final once
      // observed, and a 1s interval would refetch forever on a connection slower than that.
      intervalMs: Math.max(stepSeconds, UP_DOWN_MIN_RECOVERY_INTERVAL_SECONDS) * 1_000,
      fetchBars: async (from, to, signal) =>
        (
          await fetchRange(
            Math.max(fromSeconds, Math.floor(from / 1_000)),
            Math.min(endSeconds, Math.floor(to / 1_000)),
            signal,
          )
        ).map(toBar),
      emit: (bar) => {
        addCandles([fromBar(bar)])
        return bar
      },
      // REST is newer than the delivered checkpoint; a buffered tick is newer than REST.
      mergeOverlap: (snapshot, live, source) => ({
        ...snapshot,
        high: Math.max(snapshot.high, live.high),
        low: Math.min(snapshot.low, live.low),
        close: source === 'buffered' ? live.close : snapshot.close,
      }),
      onError: (error) => reportCandleError(error, 'recovery'),
    })

    let lastPushed: UpDownPriceCandle | undefined
    const pushLive = (candles: UpDownPriceCandle[] | null) => {
      if (candles === null) return
      for (const candle of candles) {
        // A 30s bucket is re-sent as it grows, so an equal timestamp counts when it changed.
        if (
          lastPushed !== undefined &&
          (candle.timestamp < lastPushed.timestamp || isSameCandle(candle, lastPushed))
        )
          continue
        recovery.push(toBar(candle))
        lastPushed = candle
      }
    }
    const selectLive = (store: ReturnType<typeof useLighterStore.getState>) =>
      selectUpDownCandles(store, symbol, duration, resolution)
    pushLive(selectLive(useLighterStore.getState()))
    const unsubLive = useLighterStore.subscribe(selectLive, pushLive)

    let historyLoaded = false
    const unsubConnection = useWsSubStore.subscribe((next, previous) => {
      if (next.ws === previous.ws) return
      recovery.setConnected(!!next.ws)
    })

    const cancelHistory = withRetry(async (signal) => {
      const candles = await fetchRange(
        fromSeconds,
        Math.min(endSeconds, Math.floor(Date.now() / 1_000)),
        signal,
      )
      if (disposed || signal.aborted) return
      addCandles(candles)
      historyLoaded = true
      setState({ isLoading: false })
      const last = state.candles.at(-1)
      recovery.setHistory(last === undefined ? undefined : toBar(last))
    })

    // While history is still loading, this makes recovery run once it lands.
    const refreshLive = () => {
      recovery.setConnected(!!useWsSubStore.getState().ws)
      if (!historyLoaded) retryPending?.()
    }

    stopLive = () => {
      cancelHistory()
      recovery.dispose()
      unsubLive()
      unsubConnection()
      actions.unsubscribeUpDownPrice(symbol, duration, resolution)
      stopLive = undefined
    }
    return refreshLive
  }

  let stage: 'waiting' | 'live' | 'final' = 'waiting'
  let refreshLive: (() => void) | undefined
  let cancelFinal: (() => void) | undefined

  const finish = () => {
    if (stage === 'final') return
    stage = 'final'
    stopLive?.()
    refreshLive = undefined
    cancelFinal = loadFinal()
  }

  const begin = () => {
    if (stage !== 'waiting') return
    const now = Date.now()
    if (now >= endAt + UP_DOWN_SETTLE_GRACE_MS) {
      finish()
      return
    }
    if (now < fromSeconds * 1_000) {
      schedule(begin, fromSeconds * 1_000 - now)
      return
    }
    stage = 'live'
    setState({ isLoading: true })
    refreshLive = startLive()
    schedule(finish, endAt + UP_DOWN_SETTLE_GRACE_MS - now)
  }

  // A failed load parks while the socket is down; any reconnect resumes it, in every stage.
  const unsubConnection = useWsSubStore.subscribe((next, previous) => {
    if (next.ws !== null && next.ws !== previous.ws) retryPending?.()
  })

  begin()

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** Recovers anything missed while the page was suspended. */
    refresh() {
      if (disposed || state.isComplete) return
      // A suspended page throttles timers, so the window may have opened or ended meanwhile.
      const now = Date.now()
      if (stage === 'waiting' && now >= fromSeconds * 1_000) begin()
      else if (stage === 'live' && now >= endAt + UP_DOWN_SETTLE_GRACE_MS) finish()
      else if (refreshLive) refreshLive()
      else retryPending?.()
    },
    dispose() {
      disposed = true
      unsubConnection()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      stopLive?.()
      cancelFinal?.()
      listeners.clear()
    },
  }
}

export type UpDownSeries = ReturnType<typeof createUpDownSeries>
