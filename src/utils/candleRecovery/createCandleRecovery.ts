import { wsChannelReconnectTimeout } from '../../lighter-ws/utils/wsChannelReconnectTimeout'

/** Serializes history recovery and streaming for one chart subscriber. */
export function createCandleRecovery<Bar extends { time: number }>(options: {
  initialBar?: Bar
  waitForHistory?: boolean
  connected: boolean
  intervalMs: number
  fetchBars: (from: number, to: number, signal: AbortSignal) => Promise<Bar[]>
  emit: (bar: Bar, historical: boolean) => Bar
  onError: (error: unknown) => void
  mergeOverlap: (snapshot: Bar, live: Bar, source?: 'checkpoint' | 'buffered') => Bar
  now?: () => number
}) {
  let last = options.initialBar ? { ...options.initialBar } : undefined
  let connected = options.connected
  let awaitingHistory = options.waitForHistory ?? false
  let paused = !connected || awaitingHistory
  let recoverAfterHistory = false
  let failures = 0
  let disposed = false
  let generation = 0
  let request: AbortController | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const buffered = new Map<number, Bar>()
  let resumeReplay: (() => void) | undefined

  const yieldReplay = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resumeReplay = undefined
        resolve()
      }, 0)
      resumeReplay = () => {
        clearTimeout(timer)
        resumeReplay = undefined
        resolve()
      }
    })

  const invalidate = () => {
    generation++
    request?.abort()
    clearTimeout(retry)
    resumeReplay?.()
    buffered.clear()
  }
  const deliver = (bar: Bar, historical: boolean) => {
    if (last && bar.time < last.time) return
    // emit returns the private checkpoint, isolated from the chart callback.
    last = options.emit(bar, historical)
  }

  const recover = async () => {
    if (disposed || !connected || awaitingHistory) return
    if (!last) {
      paused = false
      return
    }
    const run = ++generation
    const controller = new AbortController()
    request = controller
    buffered.clear()
    try {
      const recovered = new Map<number, Bar>()
      const checkpoint = last
      let from = checkpoint.time
      // If a candle closes while REST is in flight, fetch again before
      // advancing past it. Otherwise its provisional close would become
      // immutable history in TradingView when we replay the next candle.
      while (true) {
        const startedAt = (options.now ?? Date.now)()
        buffered.clear()
        const bars = await options.fetchBars(from, startedAt + 1, controller.signal)
        if (disposed || run !== generation) return
        if (controller.signal.aborted) throw new Error('Candle recovery aborted')
        for (const bar of bars) recovered.set(bar.time, bar)
        const finishedAt = (options.now ?? Date.now)()
        if (
          Math.floor(startedAt / options.intervalMs) === Math.floor(finishedAt / options.intervalMs)
        )
          break
        from = Math.max(from, Math.floor(startedAt / options.intervalMs) * options.intervalMs)
      }
      const ordered = [...recovered.values()]
        .filter((bar) => bar.time >= last!.time)
        .sort((a, b) => a.time - b.time)
      // Closed candles are authoritative REST corrections. Only the latest
      // snapshot can overlap an in-flight live candle; reconcile its full OHLCV.
      const latest = ordered.at(-1)
      for (let index = 0; index < ordered.length; index++) {
        // Give chart rendering/native bridge work time to run during long gaps.
        // Cancellation resolves this yield as well, releasing the retained bars.
        if (index > 0 && index % 50 === 0) await yieldReplay()
        if (disposed || run !== generation) return
        const bar = ordered[index]!
        let recoveredBar = bar
        if (index === ordered.length - 1) {
          // Closed REST bars correct stale wicks. This assumes REST finalizes them
          // at the boundary; later backend revisions require a separate cache reset.
          const now = (options.now ?? Date.now)()
          if (
            checkpoint.time === bar.time &&
            bar.time <= now &&
            now < bar.time + options.intervalMs
          ) {
            recoveredBar = options.mergeOverlap(bar, checkpoint, 'checkpoint')
          }
          const live = buffered.get(bar.time)
          if (live) recoveredBar = options.mergeOverlap(recoveredBar, live, 'buffered')
        }
        deliver(recoveredBar, true)
      }
      for (const bar of [...buffered.values()].sort((a, b) => a.time - b.time)) {
        if (disposed || run !== generation) return
        if (!latest || bar.time > latest.time) deliver(bar, false)
      }
      if (disposed || run !== generation) return
      buffered.clear()
      paused = false
      failures = 0
    } catch (error) {
      if (disposed || run !== generation) return
      buffered.clear()
      failures++
      // A fresh reconnect/foreground refresh re-arms recovery after this bounded cycle.
      // The first retry is immediate: the usual first failure is a request issued
      // before a waking tab has its network back, and the next one succeeds.
      if (failures < 5)
        retry = setTimeout(
          () => void recover(),
          failures === 1 ? 0 : wsChannelReconnectTimeout(failures - 1),
        )
      else {
        paused = false // Keep streaming if REST remains unavailable; accept the missing gap.
        // Report the exhausted cycle, not each transient failure that then heals.
        if (!(error instanceof Error && error.name === 'AbortError')) options.onError(error)
      }
    }
  }

  return {
    get needsHistory() {
      return awaitingHistory || !last
    },
    push(bar: Bar) {
      if (disposed || (!awaitingHistory && last && bar.time < last.time)) return
      if (paused) {
        buffered.set(bar.time, { ...bar })
        // Bound history retained during an unusually long initial load.
        if (buffered.size > 5000) {
          buffered.delete(buffered.keys().next().value!)
          recoverAfterHistory = true
        }
      } else deliver(bar, false)
    },
    setConnected(value: boolean) {
      if (disposed) return
      // Also called for a socket replacement without an intermediate null.
      invalidate()
      connected = value
      failures = 0
      if (awaitingHistory) recoverAfterHistory = true
      paused = true
      if (connected) void recover()
    },
    resetHistory() {
      invalidate()
      awaitingHistory = true
      recoverAfterHistory = false
      paused = true
    },
    setHistory(bar: Bar | undefined) {
      if (disposed) return
      const pending = [...buffered.values()].sort((a, b) => a.time - b.time)
      invalidate()
      last = bar ? { ...bar } : undefined
      awaitingHistory = false
      paused = !connected
      // Ordinary init replays its channel buffer. Connection changes or buffer
      // overflow during history loading require REST catch-up after seeding.
      const needsRecovery = recoverAfterHistory
      recoverAfterHistory = false
      failures = 0
      if (connected && bar && needsRecovery) {
        paused = true
        void recover()
      } else if (connected && pending.length) {
        const run = generation
        paused = true
        // Preserve updates beyond the history cutoff without another REST request.
        for (const value of pending) buffered.set(value.time, value)
        void (async () => {
          let count = 0
          while (buffered.size) {
            const batch = [...buffered.values()].sort((a, b) => a.time - b.time)
            buffered.clear()
            for (const value of batch) {
              if (count > 0 && count % 50 === 0) await yieldReplay()
              if (disposed || generation !== run) return
              const next =
                last?.time === value.time ? options.mergeOverlap(last, value, 'buffered') : value
              deliver(next, false)
              count++
            }
          }
          if (!disposed && generation === run) paused = false
        })().catch((error: unknown) => {
          if (disposed || generation !== run) return
          buffered.clear()
          paused = false
          options.onError(error)
        })
      }
    },
    dispose() {
      disposed = true
      invalidate()
    },
  }
}
