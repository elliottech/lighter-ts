import { afterEach, expect, it, vi } from 'vitest'

import { createCandleRecovery } from './createCandleRecovery'

type Bar = { time: number; close: number }
const bar = (time: number, close = time): Bar => ({ time, close })
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
function setup(initialBar: Bar | undefined = bar(100)) {
  const pending: Array<{
    resolve: (bars: Bar[]) => void
    reject: (error: Error) => void
    signal: AbortSignal
  }> = []
  const emit = vi.fn<(value: Bar, historical: boolean) => Bar>((value) => value)
  const onError = vi.fn()
  const fetchBars = vi.fn(
    (_from: number, _to: number, signal: AbortSignal) =>
      new Promise<Bar[]>((resolve, reject) => {
        pending.push({ resolve, reject, signal })
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
  const now = vi.fn(() => 400)
  const controller = createCandleRecovery({
    initialBar,
    intervalMs: 100,
    connected: true,
    emit,
    onError,
    fetchBars,
    now,
    mergeOverlap: (snapshot) => snapshot,
  })
  return { controller, pending, emit, onError, fetchBars, now }
}

afterEach(() => vi.useRealTimers())

it('holds live updates until history replaces the last candle and fills the gap', async () => {
  const s = setup()
  s.controller.setConnected(false)
  s.controller.setConnected(true)
  s.controller.push(bar(500))
  expect(s.emit).not.toHaveBeenCalled()
  expect(s.fetchBars).toHaveBeenCalledWith(100, 401, expect.any(AbortSignal))
  s.pending[0]!.resolve([bar(300), bar(100, 101), bar(200)])
  await flush()
  expect(s.emit.mock.calls).toEqual([
    [bar(100, 101), true],
    [bar(200), true],
    [bar(300), true],
    [bar(500), false],
  ])
  s.controller.push(bar(500, 501))
  expect(s.emit).toHaveBeenLastCalledWith(bar(500, 501), false)
  s.controller.dispose()
})

it('does not replay buffered closed candles over corrected history', async () => {
  const s = setup()
  s.controller.setConnected(false)
  s.controller.setConnected(true)
  s.controller.push(bar(200, 1))
  s.pending[0]!.resolve([bar(100), bar(200, 2), bar(300)])
  await flush()
  expect(s.emit.mock.calls).toEqual([
    [bar(100), true],
    [bar(200, 2), true],
    [bar(300), true],
  ])
  s.controller.dispose()
})

it('aborts and ignores in-flight responses from an older connection', async () => {
  const s = setup()
  s.controller.setConnected(false)
  s.controller.setConnected(true)
  s.controller.setConnected(false)
  expect(s.pending[0]!.signal.aborted).toBe(true)
  s.controller.setConnected(true)
  s.pending[0]!.resolve([bar(100), bar(300)])
  await flush()
  expect(s.emit).not.toHaveBeenCalled()
  s.pending[1]!.resolve([bar(100), bar(200)])
  await flush()
  expect(s.emit).toHaveBeenLastCalledWith(bar(200), true)
  s.controller.dispose()
})

it('keeps delivery paused on failure and retries from the original checkpoint', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.controller.setConnected(false)
  s.controller.setConnected(true)
  s.pending[0]!.reject(new Error('offline'))
  await flush()
  s.controller.push(bar(300))
  expect(s.emit).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(3000)
  expect(s.fetchBars.mock.calls[1]![0]).toBe(100)
  s.pending[1]!.resolve([bar(100), bar(200), bar(300)])
  await flush()
  expect(s.emit).toHaveBeenLastCalledWith(bar(300), true)
  s.controller.dispose()
})

it('refetches a candle that closes during recovery before advancing past it', async () => {
  const s = setup()
  s.controller.setConnected(false)
  s.controller.setConnected(true)
  s.now.mockReturnValue(500)
  s.controller.push(bar(500))
  s.pending[0]!.resolve([bar(100), bar(400, 401)])
  await flush()
  expect(s.emit).not.toHaveBeenCalled()
  expect(s.fetchBars.mock.calls[1]!.slice(0, 2)).toEqual([400, 501])
  s.pending[1]!.resolve([bar(400, 499), bar(500)])
  await flush()
  expect(s.emit.mock.calls).toEqual([
    [bar(100), true],
    [bar(400, 499), true],
    [bar(500), true],
  ])
  s.controller.dispose()
})

it('invalidates old-mode recovery and waits for new history after a price-mode reset', async () => {
  const s = setup()
  s.controller.setConnected(false)
  s.controller.setConnected(true)
  s.controller.resetHistory()
  s.controller.push(bar(600))
  s.pending[0]!.resolve([bar(100), bar(200)])
  await flush()
  expect(s.emit).not.toHaveBeenCalled()
  s.controller.setConnected(true)
  s.controller.setHistory(bar(300, 3))
  expect(s.fetchBars.mock.calls[1]![0]).toBe(300)
  s.pending[1]!.resolve([bar(300, 4)])
  await flush()
  expect(s.emit).toHaveBeenCalledExactlyOnceWith(bar(300, 4), true)
  s.controller.dispose()
})

it('ignores late responses after unsubscribe and cancels retry timers', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.controller.setConnected(false)
  s.controller.setConnected(true)
  s.controller.dispose()
  s.pending[0]!.resolve([bar(100), bar(200)])
  await vi.runAllTimersAsync()
  s.controller.push(bar(300))
  expect(s.emit).not.toHaveBeenCalled()
  expect(s.fetchBars).toHaveBeenCalledTimes(1)
})

it('keeps independent checkpoints for two chart subscriptions', async () => {
  const a = setup(bar(100))
  const b = setup(bar(200))
  for (const s of [a, b]) {
    s.controller.setConnected(false)
    s.controller.setConnected(true)
  }
  a.pending[0]!.resolve([bar(100), bar(300)])
  await flush()
  expect(b.emit).not.toHaveBeenCalled()
  expect(b.fetchBars.mock.calls[0]![0]).toBe(200)
  b.pending[0]!.resolve([bar(200), bar(300)])
  await flush()
  expect(b.emit.mock.calls).toEqual([
    [bar(200), true],
    [bar(300), true],
  ])
  a.controller.dispose()
  b.controller.dispose()
})

it('allows an empty-history market to receive its first live candle', () => {
  const s = setup()
  s.controller.setHistory(undefined)
  s.controller.push(bar(100))
  expect(s.emit).toHaveBeenCalledExactlyOnceWith(bar(100), false)
  s.controller.dispose()
})

it('stops a recovery replay when the chart removes itself from its callback', async () => {
  const s = setup()
  s.emit.mockImplementation((value) => {
    s.controller.dispose()
    return value
  })
  s.controller.setConnected(true)
  s.pending[0]!.resolve([bar(100), bar(200), bar(300)])
  await flush()
  expect(s.emit).toHaveBeenCalledTimes(1)
})

it('clears an already scheduled retry on disposal', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.controller.setConnected(true)
  s.pending[0]!.reject(new Error('offline'))
  await flush()
  expect(vi.getTimerCount()).toBe(1)
  s.controller.dispose()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(s.fetchBars).toHaveBeenCalledTimes(1)
})

it('yields long recovery replays and releases the continuation on unmount', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.controller.setConnected(true)
  s.pending[0]!.resolve(Array.from({ length: 1000 }, (_, i) => bar(100 + i)))
  await flush()
  expect(s.emit).toHaveBeenCalledTimes(50)
  expect(vi.getTimerCount()).toBe(1)
  s.controller.dispose()
  await flush()
  expect(vi.getTimerCount()).toBe(0)
  await vi.runAllTimersAsync()
  expect(s.emit).toHaveBeenCalledTimes(50)
})

it('preserves order and reconciles live candles received during a replay yield', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.controller.setConnected(true)
  s.pending[0]!.resolve(Array.from({ length: 150 }, (_, i) => bar(100 + i)))
  await flush()
  s.controller.push(bar(300))
  await vi.runAllTimersAsync()
  expect(s.emit.mock.calls.map(([value]) => value.time)).toEqual([
    ...Array.from({ length: 150 }, (_, i) => 100 + i),
    300,
  ])
  expect(vi.getTimerCount()).toBe(0)
  s.controller.dispose()
})

it('retries at once, backs off, and reports only the exhausted cycle before rearming on reconnect', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.controller.setConnected(true)
  const delays = [0, 3000, 6000, 10000]
  for (let i = 0; i < 5; i++) {
    s.pending[i]!.reject(new Error('REST unavailable'))
    await flush()
    expect(s.onError).toHaveBeenCalledTimes(i < 4 ? 0 : 1)
    if (i < 4) {
      if (delays[i]! > 0) {
        await vi.advanceTimersByTimeAsync(delays[i]! - 1)
        expect(s.fetchBars).toHaveBeenCalledTimes(i + 1)
      }
      await vi.advanceTimersByTimeAsync(1)
      expect(s.fetchBars).toHaveBeenCalledTimes(i + 2)
    }
  }
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(120000)
  expect(s.fetchBars).toHaveBeenCalledTimes(5)
  s.controller.push(bar(200))
  expect(s.emit).toHaveBeenLastCalledWith(bar(200), false)
  s.controller.setConnected(true)
  s.pending[5]!.resolve([bar(100), bar(200)])
  await flush()
  expect(s.emit).toHaveBeenLastCalledWith(bar(200), true)
  s.controller.setConnected(true)
  s.pending[6]!.reject(new Error('new outage'))
  await flush()
  expect(s.onError).toHaveBeenCalledTimes(1)
  s.controller.dispose()
})

it('seeds a pending initial history without an extra REST request and accepts subsequent live data', () => {
  const emit = vi.fn((b: Bar) => b)
  const fetchBars = vi.fn(() => Promise.resolve([] as Bar[]))
  const c = createCandleRecovery({
    connected: true,
    waitForHistory: true,
    intervalMs: 100,
    emit,
    fetchBars,
    onError: vi.fn(),
    mergeOverlap: (b) => b,
  })
  c.push(bar(100))
  expect(emit).not.toHaveBeenCalled()
  c.setHistory(undefined)
  c.push(bar(200))
  expect(emit.mock.calls.map(([b]) => b.time)).toEqual([100, 200])
  expect(fetchBars).not.toHaveBeenCalled()
  c.dispose()
})

it('replays candles beyond the initial cutoff in order and drops the old price-mode buffer', async () => {
  const s = setup()
  s.controller.resetHistory()
  s.controller.push(bar(200, 99))
  s.controller.resetHistory()
  s.controller.push(bar(400))
  s.controller.push(bar(300))
  s.controller.setHistory(bar(200))
  await flush()
  expect(s.emit.mock.calls).toEqual([
    [bar(300), false],
    [bar(400), false],
  ])
  expect(s.fetchBars).not.toHaveBeenCalled()
  s.controller.dispose()
})

it('cancels and releases an initial-history replay when disposed during a yield', async () => {
  vi.useFakeTimers()
  const s = setup()
  s.controller.resetHistory()
  for (let i = 0; i < 150; i++) s.controller.push(bar(200 + i))
  s.controller.setHistory(bar(100))
  expect(s.emit).toHaveBeenCalledTimes(50)
  s.controller.dispose()
  await vi.runAllTimersAsync()
  expect(s.emit).toHaveBeenCalledTimes(50)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds a stalled history buffer and recovers overflow from its history checkpoint', async () => {
  const s = setup()
  s.controller.resetHistory()
  for (let i = 0; i < 6000; i++) s.controller.push(bar(200 + i))
  s.controller.setHistory(bar(100))
  expect(s.fetchBars).toHaveBeenCalledTimes(1)
  s.pending[0]!.resolve([bar(100), bar(200)])
  await flush()
  expect(s.emit).toHaveBeenLastCalledWith(bar(200), true)
  s.controller.dispose()
})

it('keeps new-generation history paused when the last recovery callback resets the chart', async () => {
  const s = setup()
  s.emit.mockImplementationOnce((b) => {
    s.controller.resetHistory()
    return b
  })
  s.controller.setConnected(true)
  s.pending[0]!.resolve([bar(100)])
  await flush()
  s.controller.push(bar(200))
  expect(s.emit).toHaveBeenCalledTimes(1)
  expect(s.controller.needsHistory).toBe(true)
  s.controller.setHistory(bar(100))
  expect(s.emit).toHaveBeenLastCalledWith(bar(200), false)
  s.controller.dispose()
})

it('reports an initial replay callback error and keeps subsequent live delivery available', async () => {
  const s = setup()
  s.controller.resetHistory()
  s.controller.push(bar(200))
  s.emit.mockImplementationOnce(() => {
    throw new Error('chart callback failed')
  })
  s.controller.setHistory(bar(100))
  await flush()
  expect(s.onError).toHaveBeenCalledTimes(1)
  s.controller.push(bar(300))
  expect(s.emit).toHaveBeenLastCalledWith(bar(300), false)
  s.controller.dispose()
})
