import { CandlestickApi } from 'zklighter-perps'
import {
  CandleHistoryCancelledError,
  type createCandleSubscriptions,
} from './createCandleSubscriptions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as candleApi from '../candlesticks'
import { apis } from '../../lib/apis'
import { errorReporting } from '../../lib/errorReporting'
import type { ExtendedCandlestick } from '../../store/orderbook/types'
import {
  aggregateDisplayCandles,
  createDisplayCandleSubscriptions,
} from './createDisplayCandleSubscriptions'

const fake = vi.hoisted(() => ({
  generation: 0,
  invalidate: undefined as (() => void) | undefined,
  subscribe: vi.fn<ReturnType<typeof createCandleSubscriptions>['subscribe']>(),
  unsubscribe: vi.fn(),
  setHistory: vi.fn(),
  fetchInitialHistory: vi.fn<ReturnType<typeof createCandleSubscriptions>['fetchInitialHistory']>(),
  refresh: vi.fn(),
  clear: vi.fn(),
  dispose: vi.fn(),
}))
const ws = vi.hoisted(() => {
  type WsState = { ws: object | null }
  const listeners = new Set<(next: WsState, previous: WsState) => void>()
  let socket: object | null = {}
  return {
    store: {
      getState: () => ({ ws: socket }),
      subscribe: (listener: (next: WsState, previous: WsState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set(value: object | null) {
      const previous = { ws: socket }
      socket = value
      for (const listener of listeners) listener({ ws: socket }, previous)
    },
  }
})
vi.mock('../../ws-sub-store/useWsSubStore', () => ({ useWsSubStore: ws.store }))
vi.mock('../../lib/errorReporting', () => ({ errorReporting: { captureException: vi.fn() } }))
vi.mock('./createCandleSubscriptions', async (original) => ({
  ...(await original<typeof import('./createCandleSubscriptions')>()),
  createCandleSubscriptions: (
    _store: unknown,
    options: Parameters<typeof createCandleSubscriptions>[1],
  ) => {
    fake.invalidate = options?.onHistoryInvalidated
    return fake
  },
}))
const bar = (time: number, close = 5, volume = 1): ExtendedCandlestick => ({
  time,
  open: 2,
  high: Math.max(6, close),
  low: 1,
  close,
  volume,
  volumeBase: volume,
  lastTradeId: 1,
  marketId: 0,
  resolution: '1m',
})
const make = (options?: Parameters<typeof createDisplayCandleSubscriptions>[1]) =>
  createDisplayCandleSubscriptions(
    {} as Parameters<typeof createDisplayCandleSubscriptions>[0],
    options,
  )
const page = {
  marketId: 0,
  resolution: '3',
  showRawPrices: true,
  period: { from: 1800000000, to: 1800054000, countBack: 300 },
}
const transient = () =>
  Object.assign(new Error('Response returned an error code'), {
    name: 'ResponseError',
    response: { status: 503 },
  })
describe('display candles', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    ws.set({})
  })
  it('aligns the history window in seconds and includes a predecessor', () => {
    const streams = make()
    streams.fetchInitialHistory({
      marketId: 0,
      resolution: '3',
      showRawPrices: true,
      period: { from: 1800000000, to: 1800054000, countBack: 300 },
    })
    const request = fake.fetchInitialHistory.mock.lastCall![0]
    expect(request.period.from).toBe(1799999820)
    expect(request.period.to).toBe(1800054000)
    expect(request.period.countBack).toBe(301)
    streams.dispose()
  })
  it.each([2024, 2025])('fetches a complete monthly predecessor after February in %i', (year) => {
    const streams = make()
    streams.fetchInitialHistory({
      marketId: 0,
      resolution: '1M',
      showRawPrices: true,
      period: { from: Date.UTC(year, 2, 1) / 1000, to: Date.UTC(year, 3, 2) / 1000, countBack: 1 },
    })
    expect(fake.fetchInitialHistory.mock.lastCall![0].period.from).toBe(Date.UTC(year, 1, 1) / 1000)
    streams.dispose()
  })
  it('aborts active pagination and rejects a late response after disposal', async () => {
    let complete!: (bars: ExtendedCandlestick[]) => void
    const request = vi.spyOn(candleApi, 'fetchHistoricalCandlesticks').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const streams = make()
    const result = streams.fetchHistory({
      marketId: 0,
      resolution: '3',
      showRawPrices: true,
      period: { from: 1800000000, to: 1800054000, countBack: 300 },
    })
    const signal = request.mock.lastCall![0].signal
    streams.dispose()
    expect(signal?.aborted).toBe(true)
    complete([bar(0)])
    await expect(result).rejects.toMatchObject({ name: 'CandleHistoryCancelledError' })
    request.mockRestore()
  })
  it('forwards caller cancellation and removes its listener after settlement', async () => {
    let complete!: (bars: ExtendedCandlestick[]) => void
    const request = vi.spyOn(candleApi, 'fetchHistoricalCandlesticks').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const streams = make()
    const result = streams.fetchHistory({
      marketId: 0,
      resolution: '3',
      showRawPrices: true,
      signal: parent.signal,
      period: { from: 1800000000, to: 1800054000, countBack: 300 },
    })
    parent.abort()
    expect(request.mock.lastCall![0].signal?.aborted).toBe(true)
    complete([])
    await expect(result).rejects.toMatchObject({ name: 'CandleHistoryCancelledError' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    request.mockRestore()
    streams.dispose()
  })
  it('retries a failed older page with the initial-history backoff and releases the controller', async () => {
    vi.useFakeTimers()
    const request = vi
      .spyOn(candleApi, 'fetchHistoricalCandlesticks')
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce([bar(0)])
    const parent = new AbortController()
    const remove = vi.spyOn(parent.signal, 'removeEventListener')
    const streams = make()
    const result = streams.fetchHistory({ ...page, signal: parent.signal })
    await vi.advanceTimersByTimeAsync(2999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6000)
    await expect(result).resolves.toEqual([bar(0)])
    expect(request).toHaveBeenCalledTimes(3)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(errorReporting.captureException).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    streams.dispose()
    expect(request.mock.lastCall![0].signal?.aborted).toBe(false)
    request.mockRestore()
  })
  it.each([
    ['skips reporting a transient', transient, 0],
    ['reports an unexpected', () => new Error('unexpected'), 1],
  ])(
    '%s exhausted pagination cycle and keeps trying slowly while online',
    async (_, failure, reports) => {
      vi.useFakeTimers()
      const error = failure()
      const request = vi.spyOn(candleApi, 'fetchHistoricalCandlesticks').mockRejectedValue(error)
      const streams = make()
      const result = streams.fetchHistory(page)
      await vi.advanceTimersByTimeAsync(34000)
      expect(request).toHaveBeenCalledTimes(5)
      expect(errorReporting.captureException).toHaveBeenCalledTimes(reports)
      if (reports)
        expect(errorReporting.captureException).toHaveBeenCalledWith(error, {
          tags: { candle_path: 'pagination' },
        })
      await vi.advanceTimersByTimeAsync(59999)
      expect(request).toHaveBeenCalledTimes(5)
      request.mockResolvedValueOnce([bar(0)])
      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toEqual([bar(0)])
      expect(request).toHaveBeenCalledTimes(6)
      expect(errorReporting.captureException).toHaveBeenCalledTimes(reports)
      streams.dispose()
      request.mockRestore()
    },
  )
  it.each(['invalidate', 'dispose', 'abort'] as const)(
    'cancels a retrying page on %s without a late callback',
    async (how) => {
      vi.useFakeTimers()
      const request = vi
        .spyOn(candleApi, 'fetchHistoricalCandlesticks')
        .mockRejectedValue(new Error('page unavailable'))
      const parent = new AbortController()
      const streams = make()
      const result = streams.fetchHistory({ ...page, signal: parent.signal })
      const rejected = expect(result).rejects.toBeInstanceOf(CandleHistoryCancelledError)
      await vi.advanceTimersByTimeAsync(0)
      expect(request).toHaveBeenCalledTimes(1)
      if (how === 'invalidate') fake.invalidate?.()
      else if (how === 'dispose') streams.dispose()
      else parent.abort()
      await rejected
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60000)
      expect(request).toHaveBeenCalledTimes(1)
      streams.dispose()
      request.mockRestore()
    },
  )
  it('cancels a page whose owner left while its fetch was in flight', async () => {
    let active = true
    let complete!: (bars: ExtendedCandlestick[]) => void
    const request = vi.spyOn(candleApi, 'fetchHistoricalCandlesticks').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const streams = make({ isHistoryActive: () => active })
    const result = streams.fetchHistory(page)
    active = false
    complete([bar(0)])
    await expect(result).rejects.toBeInstanceOf(CandleHistoryCancelledError)
    expect(request).toHaveBeenCalledTimes(1)
    streams.dispose()
    request.mockRestore()
  })
  it('stops retrying once the pane no longer owns the dataset', async () => {
    vi.useFakeTimers()
    let active = true
    const request = vi
      .spyOn(candleApi, 'fetchHistoricalCandlesticks')
      .mockRejectedValue(new Error('page unavailable'))
    const streams = make({ isHistoryActive: () => active })
    const result = streams.fetchHistory(page)
    const rejected = expect(result).rejects.toBeInstanceOf(CandleHistoryCancelledError)
    await vi.advanceTimersByTimeAsync(0)
    active = false
    await vi.advanceTimersByTimeAsync(3000)
    await rejected
    expect(request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    streams.dispose()
    request.mockRestore()
  })
  it('rearms the fast cycle when a refresh arrives during an in-flight attempt', async () => {
    vi.useFakeTimers()
    let release!: (error: Error) => void
    let calls = 0
    const request = vi.spyOn(candleApi, 'fetchHistoricalCandlesticks').mockImplementation(() => {
      calls++
      if (calls < 5) return Promise.reject(transient())
      if (calls === 5)
        return new Promise((_, reject) => {
          release = reject
        })
      return Promise.resolve([bar(0)])
    })
    const streams = make()
    const result = streams.fetchHistory(page)
    await vi.advanceTimersByTimeAsync(34000)
    expect(request).toHaveBeenCalledTimes(5)
    streams.refresh()
    release(transient())
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(6)
    await expect(result).resolves.toEqual([bar(0)])
    expect(errorReporting.captureException).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    streams.dispose()
    request.mockRestore()
  })
  it.each(['refresh', 'unsubscribe', 'disconnect'] as const)(
    'prunes an abandoned page waiting without a socket on %s',
    async (how) => {
      vi.useFakeTimers()
      let active = true
      const request = vi
        .spyOn(candleApi, 'fetchHistoricalCandlesticks')
        .mockRejectedValue(new Error('page unavailable'))
      if (how !== 'disconnect') ws.set(null)
      const streams = make({ isHistoryActive: () => active })
      const result = streams.fetchHistory(page)
      const rejected = expect(result).rejects.toBeInstanceOf(CandleHistoryCancelledError)
      await vi.advanceTimersByTimeAsync(0)
      expect(request).toHaveBeenCalledTimes(1)
      active = false
      if (how === 'refresh') streams.refresh()
      else if (how === 'unsubscribe') streams.unsubscribe('pane')
      else ws.set(null)
      await rejected
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60000)
      expect(request).toHaveBeenCalledTimes(1)
      streams.dispose()
      request.mockRestore()
    },
  )
  it('holds a scheduled retry when the socket closes during its backoff', async () => {
    vi.useFakeTimers()
    const request = vi
      .spyOn(candleApi, 'fetchHistoricalCandlesticks')
      .mockRejectedValue(new Error('page unavailable'))
    const streams = make()
    const result = streams.fetchHistory(page)
    await vi.advanceTimersByTimeAsync(1000)
    expect(request).toHaveBeenCalledTimes(1)
    ws.set(null)
    await vi.advanceTimersByTimeAsync(60000)
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValueOnce([bar(0)])
    ws.set({})
    await expect(result).resolves.toEqual([bar(0)])
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    streams.dispose()
    request.mockRestore()
  })
  it('waits for a socket while offline and retries at once on reconnect or refresh', async () => {
    vi.useFakeTimers()
    const request = vi
      .spyOn(candleApi, 'fetchHistoricalCandlesticks')
      .mockRejectedValue(new Error('page unavailable'))
    ws.set(null)
    const streams = make()
    const result = streams.fetchHistory(page)
    await vi.advanceTimersByTimeAsync(120000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    streams.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    ws.set({})
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    request.mockResolvedValueOnce([bar(0)])
    streams.refresh()
    expect(fake.refresh).toHaveBeenCalledTimes(2)
    await expect(result).resolves.toEqual([bar(0)])
    expect(request).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    streams.dispose()
    request.mockRestore()
  })
  it('does not emit the inclusive REST endpoint as a partial pagination bucket', async () => {
    const start = 1789782480000
    const candles = [
      {
        t: start - 60000,
        o: 2616.23,
        h: 2616.98,
        l: 2615.95,
        c: 2616.51,
        v: 50.5477,
        V: 132249.69013499995,
        i: 1,
      },
      {
        t: start,
        o: 2616.51,
        h: 2617.46,
        l: 2616.42,
        c: 2617.38,
        v: 21.5962,
        V: 56515.67027399997,
        i: 2,
      },
      {
        t: start + 60000,
        o: 2617.38,
        h: 2618.26,
        l: 2617,
        c: 2618.26,
        v: 45.8455,
        V: 120009.22983900008,
        i: 3,
      },
      {
        t: start + 120000,
        o: 2618.26,
        h: 2620.59,
        l: 2616.37,
        c: 2617.28,
        v: 130.8403,
        V: 342770.6826530002,
        i: 4,
      },
    ]
    const oldApi = apis.candlesticksApi
    const fetch = vi.fn((request: { end_timestamp: number; count_back: number }) =>
      Promise.resolve({
        code: 200,
        c: candles.filter((c) => c.t <= request.end_timestamp).slice(-request.count_back),
      }),
    )
    apis.candlesticksApi = Object.assign(new CandlestickApi(), {
      candles: fetch,
      markPriceCandles: () => Promise.resolve({ code: 200, c: [] }),
    })
    const streams = make()
    try {
      const older = await streams.fetchHistory({
        marketId: 0,
        resolution: '3',
        showRawPrices: false,
        period: { from: 1789769700, to: start / 1000, countBack: 71 },
      })
      expect(older.every((bar) => bar.time < start)).toBe(true)
      expect(fetch.mock.calls[0]![0].end_timestamp).toBe(start - 1)
      const newer = await streams.fetchHistory({
        marketId: 0,
        resolution: '3',
        showRawPrices: false,
        period: { from: start / 1000, to: (start + 180000) / 1000, countBack: 1 },
      })
      const display = streams
        .prepareHistory(0, '3', newer, false)
        .find((bar) => bar.time === start)!
      expect([display.open, display.high, display.low, display.close]).toEqual([
        2616.51, 2620.59, 2616.37, 2617.28,
      ])
      expect(display.volume).toBeCloseTo(519295.5827660003)
    } finally {
      streams.dispose()
      apis.candlesticksApi = oldApi
    }
  })
  it('keeps a failed pagination source pending instead of treating it as the end of history', async () => {
    vi.useFakeTimers()
    const oldApi = apis.candlesticksApi
    const candles = vi.fn(() => Promise.reject(new Error('page unavailable')))
    apis.candlesticksApi = Object.assign(new CandlestickApi(), {
      candles,
      markPriceCandles: () => Promise.resolve({ code: 200, c: [] }),
    })
    const streams = make()
    try {
      const settled = vi.fn()
      const result = streams.fetchHistory({
        marketId: 0,
        resolution: '3',
        showRawPrices: false,
        period: { from: 1789769700, to: 1789782480, countBack: 71 },
      })
      void result.then(settled, settled)
      await vi.advanceTimersByTimeAsync(34000)
      expect(settled).not.toHaveBeenCalled()
      expect(candles).toHaveBeenCalledTimes(5)
      fake.invalidate?.()
      await expect(result).rejects.toBeInstanceOf(CandleHistoryCancelledError)
    } finally {
      streams.dispose()
      apis.candlesticksApi = oldApi
    }
  })
  it('aggregates full OHLC and both volumes before TV trims countBack', () => {
    expect(aggregateDisplayCandles([bar(0), bar(60000, 10, 2), bar(120000, 3, 3)], '3')).toEqual([
      { ...bar(0, 3, 6), high: 10 },
    ])
  })
  it('keeps calendar year and month boundaries', () => {
    const times = [Date.UTC(2024, 11, 31), Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1)]
    expect(
      aggregateDisplayCandles(
        times.map((t) => bar(t)),
        '1M',
      ).map((b) => b.time),
    ).toEqual([Date.UTC(2024, 11, 1), Date.UTC(2025, 0, 1), Date.UTC(2025, 1, 1)])
    expect(
      aggregateDisplayCandles(
        times.slice(0, 2).map((t) => bar(t)),
        '3D',
      ),
    ).toHaveLength(2)
  })
  it('replaces a source tick instead of adding its volume again; drops old bucket memory', () => {
    const streams = make(),
      tick = vi.fn<(bar: ExtendedCandlestick) => void>()
    streams.prepareHistory(0, '3', [bar(0), bar(60000)], true)
    streams.subscribe({ marketId: 0, resolution: '3', listenerGuid: 'a', onRealtimeCallback: tick })
    const push = fake.subscribe.mock.lastCall![0].onRealtimeCallback
    push(bar(60000, 8, 4))
    expect(tick.mock.lastCall![0].volume).toBe(5)
    push(bar(120000, 9, 2))
    expect(tick.mock.lastCall![0].volume).toBe(7)
    push(bar(180000, 10, 3))
    expect(tick.mock.lastCall![0]).toEqual(bar(180000, 10, 3))
    streams.dispose()
  })
  it('does not seed live aggregation from scroll-back history', () => {
    const streams = make(),
      tick = vi.fn<(bar: ExtendedCandlestick) => void>()
    streams.prepareHistory(0, '3', [bar(180000, 3, 7)], true)
    streams.prepareHistory(0, '3', [bar(0, 3, 99)], false)
    streams.subscribe({ marketId: 0, resolution: '3', listenerGuid: 'b', onRealtimeCallback: tick })
    fake.subscribe.mock.lastCall![0].onRealtimeCallback(bar(240000, 3, 1))
    expect(tick.mock.lastCall![0].volume).toBe(8)
    streams.dispose()
  })
  it('discards old-mode seeds after the underlying manager changes generation', () => {
    const streams = make(),
      tick = vi.fn<(bar: ExtendedCandlestick) => void>()
    streams.prepareHistory(0, '3', [bar(0, 3, 99)], true)
    streams.subscribe({ marketId: 0, resolution: '3', listenerGuid: 'c', onRealtimeCallback: tick })
    fake.generation++
    fake.subscribe.mock.lastCall![0].onRealtimeCallback(bar(60000, 3, 1))
    expect(tick.mock.lastCall![0].volume).toBe(1)
    streams.dispose()
  })
  it('keeps two same-market listeners independent during recovery', () => {
    const streams = make(),
      first = vi.fn<(bar: ExtendedCandlestick) => void>(),
      second = vi.fn<(bar: ExtendedCandlestick) => void>()
    streams.prepareHistory(0, '3', [bar(0, 3, 2), bar(60000, 4, 3)], true)
    streams.subscribe({
      marketId: 0,
      resolution: '3',
      listenerGuid: 'one',
      onRealtimeCallback: first,
    })
    const pushFirst = fake.subscribe.mock.lastCall![0].onRealtimeCallback
    streams.subscribe({
      marketId: 0,
      resolution: '3',
      listenerGuid: 'two',
      onRealtimeCallback: second,
    })
    const pushSecond = fake.subscribe.mock.lastCall![0].onRealtimeCallback
    pushFirst(bar(120000, 9, 10))
    pushSecond(bar(60000, 4, 4))
    expect(first.mock.lastCall![0].volume).toBe(15)
    expect(second.mock.lastCall![0].volume).toBe(6)
    streams.dispose()
  })
  it('releases the source seed when the last listener unsubscribes', () => {
    const streams = make(),
      tick = vi.fn<(bar: ExtendedCandlestick) => void>()
    streams.prepareHistory(0, '3', [bar(0, 3, 99)], true)
    streams.subscribe({
      marketId: 0,
      resolution: '3',
      listenerGuid: 'old',
      onRealtimeCallback: tick,
    })
    streams.unsubscribe('old')
    streams.subscribe({
      marketId: 0,
      resolution: '3',
      listenerGuid: 'new',
      onRealtimeCallback: tick,
    })
    fake.subscribe.mock.lastCall![0].onRealtimeCallback(bar(60000, 4, 1))
    expect(tick.mock.lastCall![0].volume).toBe(1)
    streams.dispose()
  })
  it('a REST correction can reduce an in-progress source range without losing its siblings', () => {
    const streams = make(),
      tick = vi.fn<(bar: ExtendedCandlestick) => void>()
    streams.prepareHistory(0, '3', [bar(0, 3, 2), bar(60000, 99, 3)], true)
    streams.subscribe({
      marketId: 0,
      resolution: '3',
      listenerGuid: 'recovery',
      onRealtimeCallback: tick,
    })
    fake.subscribe.mock.lastCall![0].onRealtimeCallback(bar(60000, 7, 4))
    expect(tick.mock.lastCall![0]).toEqual({ ...bar(0, 7, 6), high: 7 })
    streams.dispose()
  })
  it('cannot retain history or start work through a late callback after disposal', async () => {
    const streams = make()
    streams.dispose()
    fake.subscribe.mockClear()
    expect(streams.prepareHistory(0, '3', [bar(0)], true)).toEqual([])
    streams.subscribe({
      marketId: 0,
      resolution: '3',
      listenerGuid: 'late',
      onRealtimeCallback: vi.fn(),
    })
    expect(fake.subscribe).not.toHaveBeenCalled()
    await expect(
      streams.fetchHistory({
        marketId: 0,
        resolution: '3',
        showRawPrices: true,
        period: { from: 1800000000, to: 1800054000, countBack: 300 },
      }),
    ).rejects.toMatchObject({ name: 'CandleHistoryCancelledError' })
  })
  it('drops a callback captured before disposal', () => {
    const streams = make(),
      tick = vi.fn<(bar: ExtendedCandlestick) => void>()
    streams.subscribe({
      marketId: 0,
      resolution: '3',
      listenerGuid: 'old',
      onRealtimeCallback: tick,
    })
    const push = fake.subscribe.mock.lastCall![0].onRealtimeCallback
    streams.dispose()
    push(bar(0))
    expect(tick).not.toHaveBeenCalled()
  })
})

it('aborts old-mode pagination synchronously when the manager invalidates history', async () => {
  let complete!: (bars: ExtendedCandlestick[]) => void
  const fetch = vi.spyOn(candleApi, 'fetchHistoricalCandlesticks').mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const streams = make()
  const pending = streams.fetchHistory({
    marketId: 0,
    resolution: '3',
    showRawPrices: true,
    period: { from: 1800000000, to: 1800054000, countBack: 300 },
  })
  const signal = fetch.mock.lastCall![0].signal
  fake.invalidate?.()
  expect(signal?.aborted).toBe(true)
  complete([bar(0)])
  await expect(pending).rejects.toMatchObject({ name: 'CandleHistoryCancelledError' })
  streams.dispose()
  fetch.mockRestore()
})

it('does not let a lagging display listener rewind the seed for a newly joining listener', () => {
  const streams = make()
  streams.prepareHistory(0, '3', [bar(0)], true)
  streams.subscribe({
    marketId: 0,
    resolution: '3',
    listenerGuid: 'fast',
    onRealtimeCallback: vi.fn(),
  })
  const fast = fake.subscribe.mock.lastCall![0].onRealtimeCallback
  streams.subscribe({
    marketId: 0,
    resolution: '3',
    listenerGuid: 'slow',
    onRealtimeCallback: vi.fn(),
  })
  const slow = fake.subscribe.mock.lastCall![0].onRealtimeCallback
  fast(bar(180000, 7, 2))
  fast(bar(240000, 9, 3))
  slow(bar(120000, 4, 1))
  const emit = vi.fn()
  streams.subscribe({
    marketId: 0,
    resolution: '3',
    listenerGuid: 'joining',
    onRealtimeCallback: emit,
  })
  fake.subscribe.mock.lastCall![0].onRealtimeCallback(bar(240000, 10, 4))
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ time: 180000, close: 10, volume: 6 }),
  )
  streams.dispose()
})

it('preserves newer display constituents across older or empty initial history', () => {
  const streams = make()
  streams.prepareHistory(0, '3', [bar(180000, 7, 2), bar(240000, 9, 3)], true)
  streams.prepareHistory(0, '3', [bar(120000)], true)
  streams.prepareHistory(0, '3', [], true)
  const emit = vi.fn()
  streams.subscribe({
    marketId: 0,
    resolution: '3',
    listenerGuid: 'joining',
    onRealtimeCallback: emit,
  })
  fake.subscribe.mock.lastCall![0].onRealtimeCallback(bar(240000, 10, 4))
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ time: 180000, close: 10, volume: 6 }),
  )
  streams.dispose()
})
