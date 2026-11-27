import type { ExtendedCandlestick } from '../../store/orderbook/types'
import type { LighterStoreWithSubscribe } from '../../store/useLighterStore'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeWithSelector } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'

import { errorReporting } from '../../lib/errorReporting'
import { CandleHistoryCancelledError, createCandleSubscriptions } from './createCandleSubscriptions'

const mocks = vi.hoisted(() => {
  type WsState = { ws: object | null }
  const listeners = new Set<(next: WsState, previous: WsState) => void>()
  let ws: object | null = {}
  const actions = { subscribeCandle: vi.fn(), unsubscribeCandle: vi.fn() }
  return {
    history: vi.fn<(...args: unknown[]) => Promise<ExtendedCandlestick[]>>(),
    fetch:
      vi.fn<
        (
          params: Parameters<typeof import('./fetchRecoveryCandles').fetchRecoveryCandles>[0],
        ) => Promise<ExtendedCandlestick[]>
      >(),
    actions,
    listeners,
    wsStore: {
      getState: () => ({ ws, actions }),
      subscribe: (listener: (next: WsState, previous: WsState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    setWs(value: object | null) {
      const previous = { ws }
      ws = value
      for (const listener of listeners) listener({ ws }, previous)
    },
  }
})
vi.mock('../../ws-sub-store/useWsSubStore', () => ({ useWsSubStore: mocks.wsStore }))
vi.mock('../multiplier', () => ({
  realCandlesticksToDisplay: (bars: ExtendedCandlestick[]) => bars,
}))
vi.mock('../../store/orderbook/selectors', () => ({
  selectOrderBookMeta: () => ({ market_id: 1 }),
  selectNewCandlesticks: (state: { candles: ExtendedCandlestick[] }) => state.candles,
}))
vi.mock('../candlesticks', async (original) => ({
  ...(await original<typeof import('../candlesticks')>()),
  fetchHistoricalCandlesticks: mocks.history,
}))
vi.mock('../../lib/apis', () => ({ apis: { candlesticksApi: {} } }))
vi.mock('../../lib/errorReporting', () => ({ errorReporting: { captureException: vi.fn() } }))
vi.mock('./fetchRecoveryCandles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fetchRecoveryCandles')>()),
  fetchRecoveryCandles: mocks.fetch,
  getRecoveryIntervalMs: () => 60_000,
}))

const bar = (time: number, close = 10): ExtendedCandlestick => ({
  time,
  open: 10,
  high: 12,
  low: 8,
  close,
  marketId: 1,
  resolution: '1m',
  lastTradeId: 1,
})
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const managers: Array<ReturnType<typeof createCandleSubscriptions>> = []
function setup(options?: Parameters<typeof createCandleSubscriptions>[1]) {
  const store = createStore(
    subscribeWithSelector(() => ({
      preferences: { showRawPrices: true, showMarkPriceCandles: false },
      candles: [] as ExtendedCandlestick[],
    })),
  )
  const manager = createCandleSubscriptions(store as unknown as LighterStoreWithSubscribe, options)
  manager.setHistory(1, '1', bar(100))
  managers.push(manager)
  const emit = vi.fn<(bar: ExtendedCandlestick) => void>()
  manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'first',
    onRealtimeCallback: emit,
  })
  return { store, manager, emit }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actions.subscribeCandle.mockReset()
  mocks.actions.unsubscribeCandle.mockReset()
  mocks.history.mockReset()
  mocks.setWs({})
})

it('keeps the wire reference positive while replacing the only listener for a dataset', () => {
  let references = 0
  const counts: number[] = []
  mocks.actions.subscribeCandle.mockImplementation(() => counts.push(++references))
  mocks.actions.unsubscribeCandle.mockImplementation(() => counts.push(--references))
  const s = setup()
  const replacement = vi.fn()
  s.manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'first',
    onRealtimeCallback: replacement,
  })
  expect(counts).toEqual([1, 2, 1])
  s.store.setState({ candles: [bar(200)] })
  expect(s.emit).not.toHaveBeenCalled()
  expect(replacement).toHaveBeenCalledTimes(1)
  expect(mocks.fetch).not.toHaveBeenCalled()
  s.manager.dispose()
  expect(references).toBe(0)
})
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
  vi.useRealTimers()
})

it('pauses synchronously on reconnect, then updates the existing subscription', async () => {
  const s = setup()
  let resolve!: (bars: ExtendedCandlestick[]) => void
  mocks.fetch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  mocks.setWs(null)
  mocks.setWs({})
  s.store.setState({ candles: [bar(300)] })
  expect(s.emit).not.toHaveBeenCalled()
  resolve([bar(100, 11), bar(200)])
  await flush()
  expect(s.emit.mock.calls.map(([value]) => value.time)).toEqual([100, 200, 300])
  expect(mocks.actions.subscribeCandle).toHaveBeenCalledTimes(1)
})

it('cancels recovery as soon as price preferences change, before any chart effect', async () => {
  const s = setup()
  let resolve!: (bars: ExtendedCandlestick[]) => void
  mocks.fetch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  mocks.setWs(null)
  mocks.setWs({})
  const oldSignal = mocks.fetch.mock.calls[0]![0].signal
  s.store.setState({
    preferences: { showRawPrices: false, showMarkPriceCandles: true },
  })
  expect(oldSignal.aborted).toBe(true)
  resolve([bar(100, 99)])
  await flush()
  s.store.setState({ candles: [bar(200, 99)] })
  expect(s.emit).not.toHaveBeenCalled()
  mocks.fetch.mockResolvedValue([bar(200, 20)])
  mocks.setWs({})
  s.manager.setHistory(1, '1', bar(200, 19))
  await flush()
  expect(s.emit).toHaveBeenCalledExactlyOnceWith(bar(200, 20))
  expect(mocks.fetch.mock.calls[1]![0]).toMatchObject({
    showRawPrices: false,
    showMarkPriceCandles: true,
  })
})

it('cleans up listeners and aborts in-flight work when a chart unsubscribes', () => {
  const s = setup()
  mocks.fetch.mockImplementation(() => new Promise(() => {}))
  mocks.setWs(null)
  mocks.setWs({})
  const signal = mocks.fetch.mock.calls[0]![0].signal
  s.manager.unsubscribe('first')
  expect(signal.aborted).toBe(true)
  expect(mocks.listeners.size).toBe(1) // manager-level listener remains until disposal
  expect(mocks.actions.unsubscribeCandle).toHaveBeenCalledWith(1, '1m')
  s.store.setState({ candles: [bar(300)] })
  expect(s.emit).not.toHaveBeenCalled()
})

it('does not rewind an active subscriber when another chart loads older history for the same dataset', () => {
  const s = setup()
  s.store.setState({ candles: [bar(300)] })
  s.manager.setHistory(1, '1', bar(100))
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockImplementation(() => new Promise(() => {}))
  mocks.setWs(null)
  mocks.setWs({})
  expect(mocks.fetch.mock.calls[0]![0]).toMatchObject({ from: 300 })
})

it('clearing a fullscreen chart leaves another chart instance subscribed', () => {
  const first = setup()
  const second = setup()
  first.manager.clear()
  first.store.setState({ candles: [bar(200)] })
  second.store.setState({ candles: [bar(200)] })
  expect(first.emit).not.toHaveBeenCalled()
  expect(second.emit).toHaveBeenCalledExactlyOnceWith(bar(200))
  expect(mocks.listeners.size).toBe(2) // one connection listener per manager
})

it('clear invalidates a WebView history request while allowing the replacement to subscribe', () => {
  const s = setup()
  const generation = s.manager.generation
  s.manager.clear()
  expect(s.manager.generation).not.toBe(generation)
  s.manager.setHistory(1, '1', bar(200))
  s.manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'replacement',
    onRealtimeCallback: s.emit,
  })
  s.store.setState({ candles: [bar(300)] })
  expect(s.emit).toHaveBeenCalledExactlyOnceWith(bar(300))
})

it('refreshes a connected chart in place without resubscribing or resetting history', async () => {
  const { manager, emit, store } = setup()
  let resolve!: (bars: ExtendedCandlestick[]) => void
  mocks.fetch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const generation = manager.generation
  manager.refresh()
  store.setState({ candles: [bar(300)] })
  expect(emit).not.toHaveBeenCalled()
  expect(manager.generation).toBe(generation)
  resolve([bar(100, 11), bar(200)])
  await flush()
  expect(emit.mock.calls.map(([value]) => value.time)).toEqual([100, 200, 300])
  expect(mocks.actions.subscribeCandle).toHaveBeenCalledTimes(1)
  expect(mocks.actions.unsubscribeCandle).not.toHaveBeenCalled()
})

it('defers foreground refresh while offline until the socket reconnects', async () => {
  const { manager, emit } = setup()
  mocks.fetch.mockResolvedValue([bar(100, 11), bar(200)])
  mocks.setWs(null)
  manager.refresh()
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.setWs({})
  await flush()
  expect(emit.mock.calls.map(([value]) => value.time)).toEqual([100, 200])
})

it('cannot recreate subscriptions after disposal through a late chart callback', () => {
  const { manager, store, emit } = setup()
  manager.dispose()
  manager.setHistory(1, '1', bar(100))
  manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'late',
    onRealtimeCallback: emit,
  })
  manager.refresh()
  store.setState({ candles: [bar(200)] })
  manager.dispose()
  expect(mocks.listeners.size).toBe(0)
  expect(mocks.actions.subscribeCandle).toHaveBeenCalledTimes(1)
  expect(mocks.actions.unsubscribeCandle).toHaveBeenCalledTimes(1)
  expect(emit).not.toHaveBeenCalled()
})

it('balances resources across 1,000 mount, reconnect, and unmount cycles', async () => {
  vi.useFakeTimers()
  try {
    mocks.fetch.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        }),
    )
    for (let i = 0; i < 1000; i++) {
      const { manager, store, emit } = setup()
      manager.refresh()
      store.setState({ candles: [bar(200)] })
      manager.dispose()
      store.setState({ candles: [bar(300)] })
      expect(mocks.listeners.size).toBe(0)
      expect(emit).not.toHaveBeenCalled()
    }
    await flush()
    expect(mocks.actions.subscribeCandle).toHaveBeenCalledTimes(1000)
    expect(mocks.actions.unsubscribeCandle).toHaveBeenCalledTimes(1000)
    expect(mocks.fetch.mock.calls.every(([params]) => params.signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('does not request history during a high-volume steady-state stream', () => {
  const { store, emit } = setup()
  for (let i = 0; i < 10000; i++) store.setState({ candles: [bar(100 + i)] })
  expect(emit).toHaveBeenCalledTimes(10000)
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(mocks.actions.subscribeCandle).toHaveBeenCalledTimes(1)
})

it('fans out one connection listener to multiple subscribers', async () => {
  const s = setup()
  const second = vi.fn<(value: ExtendedCandlestick) => void>()
  s.manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'second',
    onRealtimeCallback: second,
  })
  expect(mocks.listeners.size).toBe(1)
  mocks.fetch.mockResolvedValue([bar(100), bar(200)])
  mocks.setWs({})
  await flush()
  expect(s.emit).toHaveBeenLastCalledWith(bar(200))
  expect(second).toHaveBeenLastCalledWith(bar(200))
  s.manager.dispose()
  expect(mocks.listeners.size).toBe(0)
})

it('isolates the private checkpoint from mutation by a chart callback', () => {
  const s = setup()
  s.emit.mockImplementation((value) => {
    value.time = -1
    value.close = 999
  })
  s.store.setState({ candles: [bar(200)] })
  mocks.fetch.mockImplementation(() => new Promise(() => {}))
  s.manager.refresh()
  expect(mocks.fetch.mock.calls[0]![0]).toMatchObject({ from: 200 })
})

it.each([false, true])('preserves equal-ID mid-price closes with raw=%s', async (raw) => {
  const s = setup()
  s.store.setState({ preferences: { showRawPrices: raw, showMarkPriceCandles: false } })
  s.manager.resetHistory()
  const time = Date.now() - 1000
  s.manager.setHistory(1, '1', { ...bar(time, 15), high: 16 })
  mocks.fetch.mockResolvedValue([{ ...bar(time, 11), high: 12 }])
  s.manager.refresh()
  await flush()
  expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ close: 15, high: 16 }))
})

it('preserves the displayed checkpoint open at the REST recovery boundary', async () => {
  const s = setup()
  s.store.setState({ preferences: { showRawPrices: false, showMarkPriceCandles: false } })
  s.manager.setHistory(1, '1', { ...bar(100), open: 120, high: 120 })
  // REST predecessor differs from the retained displayed predecessor.
  mocks.fetch.mockResolvedValue([{ ...bar(100), open: 100, high: 110 }])
  s.manager.refresh()
  await flush()
  expect(s.emit).toHaveBeenLastCalledWith(expect.objectContaining({ open: 120, high: 120 }))
})

it.each(['showRawPrices', 'showMarkPriceCandles'] as const)(
  'invalidates a WebView getBars generation synchronously for %s',
  (key) => {
    const s = setup()
    const requestGeneration = s.manager.generation
    const preferences = s.store.getState().preferences
    s.store.setState({ preferences: { ...preferences, [key]: !preferences[key] } })
    expect(s.manager.generation).toBe(requestGeneration + 1)
    s.manager.dispose()
  },
)

it('isolates a failing chart across live and recovery delivery without blocking another chart', async () => {
  const s = setup()
  const second = vi.fn<(value: ExtendedCandlestick) => void>()
  s.manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'second',
    onRealtimeCallback: second,
  })
  s.emit.mockImplementation(() => {
    throw new Error('chart failed')
  })
  expect(() => s.store.setState({ candles: [bar(200), bar(300)] })).not.toThrow()
  expect(second.mock.calls.map(([value]) => value.time)).toEqual([200, 300])
  expect(errorReporting.captureException).toHaveBeenCalledTimes(1)
  mocks.fetch.mockResolvedValue([bar(300), bar(400)])
  s.manager.refresh()
  await flush()
  expect(second).toHaveBeenLastCalledWith(bar(400))
  expect(
    mocks.fetch.mock.calls.every(([params]) => (params as { from?: number }).from === 300),
  ).toBe(true)
  expect(errorReporting.captureException).toHaveBeenCalledTimes(1)
  s.emit.mockImplementation(() => {})
  s.store.setState({ candles: [bar(500)] })
  s.emit.mockImplementation(() => {
    throw new Error('another failure')
  })
  s.store.setState({ candles: [bar(600)] })
  expect(second).toHaveBeenLastCalledWith(bar(600))
  expect(errorReporting.captureException).toHaveBeenCalledTimes(2)
})

const historyParams = {
  marketId: 1,
  resolution: '1',
  showRawPrices: false,
  period: { from: 100, to: 200, countBack: 100 },
}
it('retries initial history despite a live checkpoint after an offline failure', async () => {
  const s = setup()
  mocks.setWs(null)
  mocks.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([bar(100)])
  const pending = s.manager.fetchInitialHistory(historyParams)
  await flush()
  s.store.setState({ candles: [bar(200)] })
  mocks.fetch.mockResolvedValue([])
  mocks.setWs({})
  await expect(pending).resolves.toEqual([bar(100)])
  expect(mocks.history).toHaveBeenCalledTimes(2)
  expect(mocks.history.mock.calls[1]?.[0]).toMatchObject({
    strict: true,
  })
})
it('retries before subscribeBars exists and accepts genuinely empty history', async () => {
  const s = setup()
  s.manager.clear()
  mocks.setWs(null)
  mocks.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
  const pending = s.manager.fetchInitialHistory(historyParams)
  await flush()
  mocks.setWs({})
  await expect(pending).resolves.toEqual([])
  mocks.setWs(null)
  mocks.setWs({})
  expect(mocks.history).toHaveBeenCalledTimes(2)
})
it('deduplicates pending loads and retries a failure arriving after reconnect', async () => {
  vi.useFakeTimers()
  const s = setup()
  let fail!: (error: Error) => void
  mocks.history
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    .mockResolvedValueOnce([bar(100)])
  const generation = s.manager.generation
  const pending = s.manager.fetchInitialHistory(historyParams)
  mocks.fetch.mockResolvedValue([])
  mocks.setWs(null)
  mocks.setWs({})
  s.manager.refresh()
  expect(s.manager.generation).toBe(generation)
  expect(mocks.history).toHaveBeenCalledTimes(1)
  fail(new Error('late failure'))
  await vi.advanceTimersByTimeAsync(0)
  await expect(pending).resolves.toEqual([bar(100)])
  expect(mocks.history).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
it.each(['resetHistory', 'clear', 'dispose'] as const)(
  'cancels pending history and timers on %s',
  async (method) => {
    vi.useFakeTimers()
    const s = setup()
    let signal: AbortSignal | undefined
    mocks.history.mockImplementation((params) => {
      signal = (params as { signal: AbortSignal }).signal
      return new Promise(() => {})
    })
    const pending = s.manager.fetchInitialHistory(historyParams)
    const rejected = expect(pending).rejects.toBeInstanceOf(CandleHistoryCancelledError)
    s.manager[method]()
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  },
)
it('slows initial history retries after the bounded cycle and rearms on foreground refresh', async () => {
  vi.useFakeTimers()
  const s = setup()
  mocks.history.mockRejectedValue(new Error('unavailable'))
  const pending = s.manager.fetchInitialHistory(historyParams)
  await vi.advanceTimersByTimeAsync(34000)
  expect(mocks.history).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(59999)
  expect(mocks.history).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(1)
  expect(mocks.history).toHaveBeenCalledTimes(6)
  mocks.history.mockResolvedValueOnce([bar(100)])
  mocks.fetch.mockResolvedValue([])
  s.manager.refresh()
  await expect(pending).resolves.toEqual([bar(100)])
  expect(vi.getTimerCount()).toBe(0)
})
it('heals exhausted initial history on its own once REST returns', async () => {
  vi.useFakeTimers()
  const s = setup()
  mocks.history.mockRejectedValue(new Error('unavailable'))
  const pending = s.manager.fetchInitialHistory(historyParams)
  await vi.advanceTimersByTimeAsync(34000)
  mocks.history.mockResolvedValueOnce([bar(100)])
  await vi.advanceTimersByTimeAsync(60000)
  await expect(pending).resolves.toEqual([bar(100)])
})
it('notifies an exhausted initial cycle once, and again only after it is rearmed', async () => {
  vi.useFakeTimers()
  const onInitialHistoryError = vi.fn()
  const s = setup({ onInitialHistoryError })
  mocks.history.mockRejectedValue(new Error('unavailable'))
  const pending = s.manager.fetchInitialHistory(historyParams)
  await vi.advanceTimersByTimeAsync(34000)
  expect(onInitialHistoryError).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(180000)
  expect(onInitialHistoryError).toHaveBeenCalledTimes(1)
  s.manager.refresh()
  await vi.advanceTimersByTimeAsync(34000)
  expect(onInitialHistoryError).toHaveBeenCalledTimes(2)
  mocks.history.mockResolvedValueOnce([bar(100)])
  mocks.fetch.mockResolvedValue([])
  s.manager.refresh()
  await pending
})
const namedError = (name: string, status?: number) =>
  Object.assign(new Error(name), { name }, status ? { response: { status } } : {})
it.each([
  ['TimeoutError', namedError('TimeoutError'), false],
  ['FetchError', namedError('FetchError'), false],
  ['ResponseError 503', namedError('ResponseError', 503), false],
  ['ResponseError 429', namedError('ResponseError', 429), false],
  ['ResponseError 400', namedError('ResponseError', 400), true],
  ['TypeError', namedError('TypeError'), true],
])(
  'reports an exhausted initial cycle of %s only if it is not transient',
  async (_, error, reported) => {
    vi.useFakeTimers()
    const s = setup()
    mocks.history.mockRejectedValue(error)
    const pending = s.manager.fetchInitialHistory(historyParams)
    await vi.advanceTimersByTimeAsync(19000)
    expect(errorReporting.captureException).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(15000)
    expect(mocks.history).toHaveBeenCalledTimes(5)
    if (reported)
      expect(errorReporting.captureException).toHaveBeenCalledExactlyOnceWith(error, {
        tags: { candle_path: 'initial' },
      })
    else expect(errorReporting.captureException).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.history).toHaveBeenCalledTimes(6)
    expect(errorReporting.captureException).toHaveBeenCalledTimes(reported ? 1 : 0)
    mocks.history.mockResolvedValueOnce([bar(100)])
    s.manager.refresh()
    await pending
  },
)
it('cancels an abandoned dataset when switching before subscribeBars', async () => {
  let activeMarket = 1
  const s = setup({ isHistoryActive: ({ marketId }) => marketId === activeMarket })
  s.manager.clear()
  mocks.setWs(null)
  mocks.history.mockRejectedValue(new Error('offline'))
  const old = s.manager.fetchInitialHistory(historyParams)
  const rejected = expect(old).rejects.toBeInstanceOf(CandleHistoryCancelledError)
  await flush()
  activeMarket = 2
  const current = s.manager.fetchInitialHistory({ ...historyParams, marketId: 2 })
  await rejected
  await flush()
  mocks.history.mockResolvedValueOnce([bar(200)])
  mocks.setWs({})
  await expect(current).resolves.toEqual([bar(200)])
  expect(mocks.history).toHaveBeenCalledTimes(3)
})
it('preserves displayed continuity while correcting recovered REST wicks', async () => {
  const s = setup()
  s.store.setState({ preferences: { showRawPrices: false, showMarkPriceCandles: false } })
  s.manager.setHistory(1, '1', { ...bar(100, 11), open: 9, high: 999 })
  mocks.fetch.mockResolvedValue([
    { ...bar(100, 12), open: 8, high: 13 },
    { ...bar(200, 14), open: 7, high: 15 },
  ])
  s.manager.refresh()
  await flush()
  expect(s.emit.mock.calls.map(([b]) => ({ open: b.open, close: b.close, high: b.high }))).toEqual([
    { open: 9, close: 12, high: 13 },
    { open: 12, close: 14, high: 15 },
  ])
})

it('shares identical initial loads without sharing mutable candles between charts', async () => {
  const s = setup()
  let resolve!: (bars: ExtendedCandlestick[]) => void
  mocks.history.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const first = s.manager.fetchInitialHistory(historyParams)
  const second = s.manager.fetchInitialHistory(historyParams)
  expect(mocks.history).toHaveBeenCalledTimes(1)
  resolve([bar(100)])
  const [a, b] = await Promise.all([first, second])
  expect(a).toEqual(b)
  expect(a).not.toBe(b)
  expect(a[0]).not.toBe(b[0])
})
it('keeps concurrent datasets and different history windows independent before subscriptions exist', async () => {
  const s = setup()
  s.manager.clear()
  mocks.setWs(null)
  mocks.history.mockRejectedValue(new Error('offline'))
  const first = s.manager.fetchInitialHistory(historyParams)
  const second = s.manager.fetchInitialHistory({ ...historyParams, marketId: 2 })
  const third = s.manager.fetchInitialHistory({
    ...historyParams,
    period: { ...historyParams.period, countBack: 500 },
  })
  await flush()
  mocks.history.mockResolvedValue([bar(100)])
  mocks.setWs({})
  await expect(Promise.all([first, second, third])).resolves.toHaveLength(3)
  expect(mocks.history).toHaveBeenCalledTimes(6)
})

it('aborts initial history on the last explicit unsubscribe without widget ownership', async () => {
  vi.useFakeTimers()
  const s = setup()
  let signal: AbortSignal | undefined
  mocks.history.mockImplementation((params) => {
    signal = (params as { signal: AbortSignal }).signal
    return new Promise(() => {})
  })
  const pending = s.manager.fetchInitialHistory(historyParams)
  const rejected = expect(pending).rejects.toBeInstanceOf(CandleHistoryCancelledError)
  s.manager.unsubscribe('first')
  await rejected
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  mocks.setWs(null)
  mocks.setWs({})
  s.manager.refresh()
  expect(mocks.history).toHaveBeenCalledTimes(1)
})
it('keeps initial history for remaining charts and same-guid subscription replacements', async () => {
  const s = setup()
  mocks.setWs(null)
  mocks.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([bar(100)])
  const pending = s.manager.fetchInitialHistory(historyParams)
  await flush()
  for (const listenerGuid of ['first', 'second'])
    s.manager.subscribe({ ...historyParams, listenerGuid, onRealtimeCallback: vi.fn() })
  s.manager.unsubscribe('first')
  s.manager.unsubscribe('unknown')
  mocks.fetch.mockResolvedValue([])
  mocks.setWs({})
  await expect(pending).resolves.toEqual([bar(100)])
})
it('keeps widget-owned pre-subscription history when an older subscriber leaves', async () => {
  const s = setup({ isHistoryActive: () => true })
  mocks.setWs(null)
  mocks.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([bar(100)])
  const pending = s.manager.fetchInitialHistory(historyParams)
  await flush()
  s.manager.unsubscribe('first')
  mocks.setWs({})
  await expect(pending).resolves.toEqual([bar(100)])
})

it('cancels the old dataset when replacing a subscription with another market', async () => {
  const s = setup()
  mocks.setWs(null)
  mocks.history.mockRejectedValue(new Error('offline'))
  const pending = s.manager.fetchInitialHistory(historyParams)
  const rejected = expect(pending).rejects.toBeInstanceOf(CandleHistoryCancelledError)
  await flush()
  s.manager.subscribe({
    ...historyParams,
    marketId: 2,
    listenerGuid: 'first',
    onRealtimeCallback: vi.fn(),
  })
  await rejected
})

it('uses the cancellation type for requests after disposal without starting a fetch', async () => {
  const s = setup()
  s.manager.dispose()
  await expect(s.manager.fetchInitialHistory(historyParams)).rejects.toBeInstanceOf(
    CandleHistoryCancelledError,
  )
  expect(mocks.history).not.toHaveBeenCalled()
})

it.each([false, true])('advances only a live-edge retry window (live=%s)', async (live) => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  const s = setup()
  mocks.setWs(null)
  const to = Math.floor(Date.now() / 1000) - (live ? 0 : 86400)
  const period = { from: to - 600, to, countBack: 10 }
  mocks.history.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
  const pending = s.manager.fetchInitialHistory({ ...historyParams, period })
  await flush()
  expect(errorReporting.captureException).not.toHaveBeenCalled()
  vi.setSystemTime(Date.now() + 180000)
  mocks.setWs({})
  await pending
  expect(mocks.history.mock.calls[1]?.[0]).toMatchObject({
    period: { ...period, from: period.from + (live ? 180 : 0), to: to + (live ? 180 : 0) },
  })
})

it('does not report expected aborts while keeping online failures observable', async () => {
  vi.useFakeTimers()
  const s = setup()
  mocks.history
    .mockRejectedValueOnce(new DOMException('Timed out', 'AbortError'))
    .mockResolvedValueOnce([])
  const pending = s.manager.fetchInitialHistory(historyParams)
  await vi.advanceTimersByTimeAsync(5000)
  await pending
  expect(errorReporting.captureException).not.toHaveBeenCalled()
})

it('does not widen recovery wicks from a REST predecessor absent from displayed history', async () => {
  vi.useFakeTimers()
  const time = 1_800_000_000_000
  vi.setSystemTime(time + 30_000)
  const { fetchRecoveryCandles } =
    await vi.importActual<typeof import('./fetchRecoveryCandles')>('./fetchRecoveryCandles')
  const s = setup()
  s.store.setState({ preferences: { showRawPrices: false, showMarkPriceCandles: false } })
  s.manager.setHistory(1, '1', { ...bar(time, 15), open: 14, low: 14, high: 16 })
  const source = (t: number, low: number) => ({
    t,
    o: 14,
    h: 16,
    l: low,
    c: 15,
    O: 14,
    H: 16,
    L: low,
    C: 15,
    v: 1,
    V: 15,
    i: 1,
  })
  const api = {
    candles: vi
      .fn()
      .mockResolvedValue({ code: 200, r: '1m', c: [source(time - 60_000, 11), source(time, 13)] }),
    markPriceCandles: vi
      .fn()
      .mockResolvedValue({ code: 200, r: '1m', c: [source(time - 60_000, 11), source(time, 13)] }),
  }
  mocks.fetch.mockImplementation((params) => fetchRecoveryCandles({ ...params, api }))
  mocks.setWs(null)
  mocks.setWs({})
  await vi.advanceTimersByTimeAsync(0)
  expect(s.emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ time, open: 14, low: 13, close: 15 }),
  )
})

it('does not adopt a replacement pane as owner of an abandoned request', async () => {
  let epoch = 0
  const s = setup({
    isHistoryActive: () => true,
    getHistoryOwner: () => {
      const owner = epoch
      return () => owner === epoch
    },
  })
  mocks.setWs(null)
  mocks.history.mockRejectedValue(new Error('offline'))
  const pending = s.manager.fetchInitialHistory(historyParams)
  const rejected = expect(pending).rejects.toBeInstanceOf(CandleHistoryCancelledError)
  await flush()
  epoch++
  mocks.setWs({})
  await rejected
  expect(mocks.history).toHaveBeenCalledTimes(1)
})

it('cancels initial work without clearing existing stream checkpoints', async () => {
  const s = setup()
  mocks.history.mockImplementation(() => new Promise(() => {}))
  const pending = s.manager.fetchInitialHistory(historyParams)
  const rejected = expect(pending).rejects.toBeInstanceOf(CandleHistoryCancelledError)
  const generation = s.manager.generation
  expect(s.manager.cancelInitialHistory()).toBe(1)
  await rejected
  expect(s.manager.generation).toBe(generation)
  expect(s.manager.cancelInitialHistory()).toBe(0)
  mocks.fetch.mockResolvedValue([bar(200)])
  s.manager.refresh()
  await flush()
  expect(s.emit).toHaveBeenCalledWith(expect.objectContaining({ time: 200 }))
})

it('does not let lagging delivery rewind the seed for a replacement subscriber', () => {
  const s = setup()
  s.manager.setHistory(1, '1', bar(300))
  // The existing subscriber still owns its private cursor at 100.
  s.store.setState({ candles: [bar(200)] })
  expect(s.emit).toHaveBeenCalledWith(expect.objectContaining({ time: 200 }))
  const replacement = vi.fn()
  s.manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'new',
    onRealtimeCallback: replacement,
  })
  s.store.setState({ candles: [bar(250)] })
  expect(replacement).not.toHaveBeenCalled()
  s.store.setState({ candles: [bar(300)] })
  expect(replacement).toHaveBeenCalledWith(expect.objectContaining({ time: 300 }))
})

it.each([bar(100), undefined])(
  'does not replace a newer shared seed with old or failed history: %s',
  (history) => {
    const s = setup()
    s.store.setState({ candles: [bar(300)] })
    s.manager.setHistory(1, '1', history)
    const replacement = vi.fn()
    s.manager.subscribe({
      marketId: 1,
      resolution: '1',
      listenerGuid: 'new',
      onRealtimeCallback: replacement,
    })
    s.store.setState({ candles: [bar(200)] })
    expect(replacement).not.toHaveBeenCalled()
  },
)

it('keeps a replacement listener ahead of a sibling paused in a long replay', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const s = setup()
  const lagging = vi.fn<(value: ExtendedCandlestick) => void>()
  s.manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'lagging',
    onRealtimeCallback: lagging,
  })
  mocks.fetch
    .mockResolvedValueOnce([bar(100), bar(300)])
    .mockResolvedValueOnce(Array.from({ length: 101 }, (_, index) => bar(100 + index)))
  s.manager.refresh()
  await flush()
  expect(s.emit.mock.calls.at(-1)?.[0].time).toBe(300)
  expect(lagging).toHaveBeenCalledTimes(50)
  const replacement = vi.fn()
  s.manager.subscribe({
    marketId: 1,
    resolution: '1',
    listenerGuid: 'new',
    onRealtimeCallback: replacement,
  })
  s.store.setState({ candles: [bar(250)] })
  expect(replacement).not.toHaveBeenCalled()
  await vi.runAllTimersAsync()
  expect(lagging.mock.calls.at(-1)?.[0].time).toBe(250)
  expect(replacement).not.toHaveBeenCalled()
})

it('keeps a deduplicated initial load owned by its second caller', async () => {
  let active = 0
  const live = [true, true]
  const s = setup({
    getHistoryOwner: () => {
      const owner = active
      return () => live[owner]!
    },
  })
  let complete!: (bars: ExtendedCandlestick[]) => void
  mocks.history.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const first = s.manager.fetchInitialHistory(historyParams)
  active = 1
  const second = s.manager.fetchInitialHistory(historyParams)
  const results = Promise.allSettled([first, second])
  live[0] = false
  mocks.fetch.mockResolvedValue([])
  s.manager.refresh()
  complete([bar(100)])
  expect((await results)[1]).toMatchObject({ status: 'fulfilled', value: [bar(100)] })
  expect(mocks.history).toHaveBeenCalledTimes(1)
})
it('honors foreground resume while the last bounded initial attempt is in flight', async () => {
  vi.useFakeTimers()
  const s = setup()
  let fail!: (error: Error) => void
  mocks.history.mockRejectedValue(new Error('offline'))
  for (let i = 0; i < 4; i++) mocks.history.mockRejectedValueOnce(new Error('offline'))
  mocks.history.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  const pending = s.manager.fetchInitialHistory(historyParams)
  const result = pending.catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(60000)
  expect(mocks.history).toHaveBeenCalledTimes(5)
  mocks.fetch.mockResolvedValue([])
  s.manager.refresh()
  mocks.history.mockResolvedValue([bar(100)])
  fail(new Error('late failure'))
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.history).toHaveBeenCalledTimes(6)
  expect(await result).toEqual([bar(100)])
})
it('notifies display pagination on explicit and preference-driven history invalidation', () => {
  const onHistoryInvalidated = vi.fn()
  const s = setup({ onHistoryInvalidated })
  s.manager.resetHistory()
  s.manager.clear()
  s.store.setState({ preferences: { showRawPrices: false, showMarkPriceCandles: false } })
  expect(onHistoryInvalidated).toHaveBeenCalledTimes(3)
})

it('cancels only selected pane owners and preserves a shared sibling load', async () => {
  let owners = ['pane0', 'pane1']
  const s = setup({ getHistoryOwnerKeys: () => owners, getHistoryOwner: () => () => true })
  const completions: Array<(bars: ExtendedCandlestick[]) => void> = []
  mocks.history.mockImplementation(
    () =>
      new Promise((resolve) => {
        completions.push(resolve)
      }),
  )
  const shared = s.manager.fetchInitialHistory(historyParams)
  owners = ['pane0']
  const selected = s.manager.fetchInitialHistory({ ...historyParams, resolution: '3' })
  const rejected = expect(selected).rejects.toBeInstanceOf(CandleHistoryCancelledError)
  expect(s.manager.cancelInitialHistory((owner) => owner === 'pane0')).toBe(2)
  await rejected
  completions[0]!([bar(100)])
  await expect(shared).resolves.toEqual([bar(100)])
})

it('supersedes a replaced initial window for the same captured owners only', async () => {
  let owner = 'first'
  const s = setup({ getHistoryOwnerKeys: () => [owner] })
  mocks.history.mockImplementation(() => new Promise(() => {}))
  const first = s.manager.fetchInitialHistory(historyParams)
  const rejected = expect(first).rejects.toMatchObject({ reason: 'superseded' })
  owner = 'second'
  const sibling = s.manager.fetchInitialHistory({
    ...historyParams,
    period: { ...historyParams.period, to: 1001 },
  })
  const siblingOutcome = sibling.catch((error: unknown) => error)
  owner = 'first'
  const replacement = s.manager.fetchInitialHistory({
    ...historyParams,
    period: { ...historyParams.period, to: 1002 },
  })
  const replacementOutcome = replacement.catch((error: unknown) => error)
  await rejected
  expect((mocks.history.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(true)
  expect((mocks.history.mock.calls[1]![0] as { signal: AbortSignal }).signal.aborted).toBe(false)
  s.manager.clear()
  await Promise.all([siblingOutcome, replacementOutcome])
})

it('exposes exhausted initial history and clears the failure after recovery', async () => {
  vi.useFakeTimers()
  const onInitialHistoryError = vi.fn(),
    onInitialHistorySuccess = vi.fn()
  const s = setup({ onInitialHistoryError, onInitialHistorySuccess })
  mocks.history.mockRejectedValue(new Error('unavailable'))
  const pending = s.manager.fetchInitialHistory(historyParams)
  await vi.advanceTimersByTimeAsync(60000)
  expect(onInitialHistoryError).toHaveBeenCalledTimes(1)
  mocks.history.mockResolvedValue([bar(100)])
  mocks.fetch.mockResolvedValue([])
  s.manager.refresh()
  await pending
  expect(onInitialHistorySuccess).toHaveBeenCalledTimes(1)
})

it('rejects only the cancelled caller of a deduplicated initial request', async () => {
  let owner = 'paneA'
  const s = setup({ getHistoryOwnerKeys: () => [owner], getHistoryOwner: () => () => true })
  let complete!: (bars: ExtendedCandlestick[]) => void
  mocks.history.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const first = s.manager.fetchInitialHistory(historyParams)
  const firstResult = first.catch((error: unknown) => error)
  owner = 'paneB'
  const second = s.manager.fetchInitialHistory(historyParams)
  expect(s.manager.cancelInitialHistory((key) => key === 'paneA')).toBe(1)
  complete([bar(100)])
  expect(await firstResult).toBeInstanceOf(CandleHistoryCancelledError)
  await expect(second).resolves.toEqual([bar(100)])
  expect(mocks.history).toHaveBeenCalledTimes(1)
})
