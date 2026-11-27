import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UpDownPriceCandle } from '../../ws-sub-store/upDownPrice'
import { createUpDownSeries } from './createUpDownSeries'

const mocks = vi.hoisted(() => {
  type WsState = { ws: object | null }
  const wsListeners = new Set<(next: WsState, previous: WsState) => void>()
  const liveListeners = new Set<() => void>()
  let ws: object | null = {}
  let live: Record<string, UpDownPriceCandle[]> = {}
  const actions = { subscribeUpDownPrice: vi.fn(), unsubscribeUpDownPrice: vi.fn() }
  return {
    actions,
    upDownCandles: vi.fn(),
    wsStore: {
      getState: () => ({ ws, actions }),
      subscribe: (listener: (next: WsState, previous: WsState) => void) => {
        wsListeners.add(listener)
        return () => wsListeners.delete(listener)
      },
    },
    lighterStore: {
      getState: () => ({ live }),
      subscribe: <T>(
        selector: (state: { live: typeof live }) => T,
        listener: (value: T) => void,
      ) => {
        let previous = selector({ live })
        const notify = () => {
          const next = selector({ live })
          if (next !== previous) {
            previous = next
            listener(next)
          }
        }
        liveListeners.add(notify)
        return () => liveListeners.delete(notify)
      },
    },
    setWs(value: object | null) {
      const previous = { ws }
      ws = value
      for (const listener of wsListeners) listener({ ws }, previous)
    },
    setLive(key: string, candles: UpDownPriceCandle[]) {
      live = { ...live, [key]: candles }
      for (const listener of liveListeners) listener()
    },
    reset() {
      ws = {}
      live = {}
      wsListeners.clear()
      liveListeners.clear()
    },
  }
})

vi.mock('../../ws-sub-store/useWsSubStore', () => ({ useWsSubStore: mocks.wsStore }))
vi.mock('../../store/useLighterStore', () => ({ useLighterStore: mocks.lighterStore }))
vi.mock('../../store/orderbook/selectors', () => ({
  selectUpDownCandles: (
    state: { live: Record<string, UpDownPriceCandle[]> },
    symbol: string,
    duration: number,
    resolution: string,
  ) => state.live[`${symbol}:${duration}:${resolution}`] ?? null,
}))
vi.mock('../../lib/apis', () => ({ apis: { updownApi: { upDownCandles: mocks.upDownCandles } } }))
vi.mock('../../lib/errorReporting', () => ({ errorReporting: { captureException: vi.fn() } }))

const START = 1_000_000
const START_MS = START * 1_000
const DURATION = 900
const END_MS = START_MS + DURATION * 1_000

const candle = (timestamp: number, close = timestamp): UpDownPriceCandle => ({
  timestamp,
  open: close,
  high: close,
  low: close,
  close,
})

const wireCandle = (timestamp: number, close = timestamp) => ({
  timestamp,
  open: `${close}`,
  high: `${close}`,
  low: `${close}`,
  close: `${close}`,
})

type Request = { start_timestamp: number; end_timestamp: number; resolution: string }

// The REST mock serves every second of [from, to] that the "backend" has observed.
let observedUpTo = 0
const serveRange = () =>
  mocks.upDownCandles.mockImplementation((request: Request) => {
    const candles = []
    for (let t = request.start_timestamp; t <= Math.min(request.end_timestamp, observedUpTo); t++)
      candles.push(wireCandle(t))
    return Promise.resolve({ code: 200, candles, next_cursor: 0 })
  })

const timestamps = (series: ReturnType<typeof createUpDownSeries>) =>
  series.getState().candles.map((c) => c.timestamp)

const flush = () => vi.advanceTimersByTimeAsync(0)

describe('createUpDownSeries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.reset()
    mocks.actions.subscribeUpDownPrice.mockClear()
    mocks.actions.unsubscribeUpDownPrice.mockClear()
    mocks.upDownCandles.mockReset()
    serveRange()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const window = { symbol: 'BTC', duration: DURATION, startAt: START_MS, endAt: END_MS }

  it('loads nothing before the window opens, then starts at the lead-in', async () => {
    vi.setSystemTime(START_MS - 60_000)
    const series = createUpDownSeries(window)
    await flush()

    expect(series.getState()).toMatchObject({ candles: [], isLoading: false, isComplete: false })
    expect(mocks.upDownCandles).not.toHaveBeenCalled()
    expect(mocks.actions.subscribeUpDownPrice).not.toHaveBeenCalled()

    observedUpTo = START - 10
    await vi.advanceTimersByTimeAsync(50_000)

    expect(mocks.actions.subscribeUpDownPrice).toHaveBeenCalledWith('BTC', DURATION, '1s')
    expect(mocks.upDownCandles).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'btc',
        duration: '15m',
        resolution: '1s',
        start_timestamp: START - 10,
      }),
      expect.anything(),
    )
    expect(timestamps(series)).toEqual([START - 10])
    series.dispose()
  })

  it('merges history with live candles and ignores anything outside the window', async () => {
    vi.setSystemTime(START_MS + 5_000)
    observedUpTo = START + 5
    mocks.setLive('BTC:900:1s', [candle(START - 100), candle(START + 4), candle(START + 6)])
    const series = createUpDownSeries(window)
    await flush()

    expect(series.getState().isLoading).toBe(false)
    expect(timestamps(series)).toEqual([
      ...Array.from({ length: 16 }, (_, i) => START - 10 + i),
      START + 6,
    ])

    mocks.setLive('BTC:900:1s', [candle(START + 6), candle(START + 7, 42)])
    expect(series.getState().candles.at(-1)).toEqual(candle(START + 7, 42))
    series.dispose()
  })

  it('fills a reconnect gap from REST before replaying buffered live candles', async () => {
    vi.setSystemTime(START_MS + 10_000)
    observedUpTo = START + 10
    const series = createUpDownSeries(window)
    await flush()
    expect(timestamps(series).at(-1)).toBe(START + 10)

    mocks.setWs(null)
    vi.setSystemTime(START_MS + 400_000)
    observedUpTo = START + 400
    mocks.setLive('BTC:900:1s', [candle(START + 399), candle(START + 400)])
    mocks.setWs({})
    await vi.advanceTimersByTimeAsync(100)

    const loaded = timestamps(series)
    expect(loaded.filter((t) => t >= START)).toEqual(
      Array.from({ length: 401 }, (_, i) => START + i),
    )
    series.dispose()
  })

  it('stops the live feed after the window and loads the final candles', async () => {
    vi.setSystemTime(END_MS - 2_000)
    observedUpTo = START + DURATION - 2
    const series = createUpDownSeries(window)
    await flush()
    expect(series.getState().isComplete).toBe(false)

    observedUpTo = START + DURATION + 30
    await vi.advanceTimersByTimeAsync(7_000)

    expect(mocks.actions.unsubscribeUpDownPrice).toHaveBeenCalledWith('BTC', DURATION, '1s')
    expect(series.getState().isComplete).toBe(true)
    expect(timestamps(series).at(-1)).toBe(START + DURATION)
    series.dispose()
  })

  it('loads an ended window once, without the live feed', async () => {
    vi.setSystemTime(END_MS + 3_600_000)
    observedUpTo = START + DURATION + 3_600
    const series = createUpDownSeries(window)
    await flush()

    expect(mocks.actions.subscribeUpDownPrice).not.toHaveBeenCalled()
    expect(mocks.upDownCandles).toHaveBeenCalledTimes(1)
    expect(mocks.upDownCandles).toHaveBeenCalledWith(
      expect.objectContaining({
        start_timestamp: START - 10,
        end_timestamp: START + DURATION + 60,
      }),
      expect.anything(),
    )
    expect(series.getState()).toMatchObject({ isLoading: false, isComplete: true })
    expect(timestamps(series)).toHaveLength(DURATION + 11)
    series.dispose()
  })

  it('pages with next_cursor', async () => {
    vi.setSystemTime(END_MS + 60_000)
    mocks.upDownCandles
      .mockResolvedValueOnce({
        code: 200,
        candles: [wireCandle(START)],
        next_cursor: START + 500,
      })
      .mockResolvedValueOnce({ code: 200, candles: [wireCandle(START + 500)], next_cursor: 0 })
    const series = createUpDownSeries(window)
    await flush()

    expect(mocks.upDownCandles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ start_timestamp: START + 500 }),
      expect.anything(),
    )
    expect(timestamps(series)).toEqual([START, START + 500])
    series.dispose()
  })

  it('retries failed history while connected and waits for a reconnect while offline', async () => {
    vi.setSystemTime(START_MS + 5_000)
    observedUpTo = START + 5
    mocks.upDownCandles.mockRejectedValueOnce(new Error('boom'))
    const series = createUpDownSeries(window)
    await flush()
    expect(series.getState().isLoading).toBe(true)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(series.getState().isLoading).toBe(false)

    mocks.setWs(null)
    mocks.upDownCandles.mockRejectedValueOnce(new Error('offline'))
    const offline = createUpDownSeries({ ...window, symbol: 'ETH' })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(offline.getState().isLoading).toBe(true)

    mocks.setWs({})
    await flush()
    expect(offline.getState().isLoading).toBe(false)
    series.dispose()
    offline.dispose()
  })

  it('recovers with one request even when it spans a second boundary', async () => {
    vi.setSystemTime(START_MS + 10_000)
    observedUpTo = START + 10
    const series = createUpDownSeries(window)
    await flush()
    mocks.upDownCandles.mockClear()
    mocks.upDownCandles.mockImplementation(async (request: Request) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const candles = []
      for (let t = request.start_timestamp; t <= request.end_timestamp; t++)
        candles.push(wireCandle(t))
      return { code: 200, candles, next_cursor: 0 }
    })

    series.refresh()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(mocks.upDownCandles).toHaveBeenCalledTimes(1)
    series.dispose()
  })

  it('catches up on a missed start or end when refreshed', async () => {
    vi.setSystemTime(START_MS - 60_000)
    const series = createUpDownSeries(window)
    await flush()

    // Timers of a suspended page fire late; the clock moves on without them.
    vi.setSystemTime(START_MS + 5_000)
    observedUpTo = START + 5
    series.refresh()
    await flush()
    expect(mocks.actions.subscribeUpDownPrice).toHaveBeenCalledTimes(1)
    expect(timestamps(series).at(-1)).toBe(START + 5)

    vi.setSystemTime(END_MS + 60_000)
    observedUpTo = START + DURATION + 60
    series.refresh()
    await flush()
    expect(mocks.actions.unsubscribeUpDownPrice).toHaveBeenCalledTimes(1)
    expect(series.getState().isComplete).toBe(true)
    expect(mocks.actions.subscribeUpDownPrice).toHaveBeenCalledTimes(1)
    series.dispose()
  })

  it('keeps loading the final window until REST reaches its end', async () => {
    vi.setSystemTime(END_MS + 6_000)
    observedUpTo = START + DURATION - 20
    const series = createUpDownSeries(window)
    await flush()
    expect(series.getState().isComplete).toBe(false)

    observedUpTo = START + DURATION + 2
    await vi.advanceTimersByTimeAsync(3_000)

    expect(series.getState().isComplete).toBe(true)
    expect(timestamps(series).at(-1)).toBe(START + DURATION)
    series.dispose()
  })

  it('gives up waiting for the final candles after the deadline', async () => {
    vi.setSystemTime(END_MS + 6_000)
    observedUpTo = START + DURATION - 20
    const series = createUpDownSeries(window)
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)

    expect(series.getState().isComplete).toBe(true)
    series.dispose()
  })

  it('recovers after history that was in flight during a refresh', async () => {
    vi.setSystemTime(START_MS + 10_000)
    observedUpTo = START + 10
    let resolve: (value: unknown) => void = () => {}
    mocks.upDownCandles.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const series = createUpDownSeries(window)
    await flush()

    vi.setSystemTime(START_MS + 400_000)
    observedUpTo = START + 400
    series.refresh()
    resolve({
      code: 200,
      candles: Array.from({ length: 21 }, (_, i) => wireCandle(START - 10 + i)),
      next_cursor: 0,
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(timestamps(series).at(-1)).toBe(START + 400)
    series.dispose()
  })

  it('resumes a failed final load on reconnect', async () => {
    vi.setSystemTime(END_MS + 60_000)
    observedUpTo = START + DURATION + 60
    mocks.setWs(null)
    mocks.upDownCandles.mockRejectedValueOnce(new Error('offline'))
    const series = createUpDownSeries(window)
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.upDownCandles).toHaveBeenCalledTimes(1)
    expect(series.getState().isComplete).toBe(false)

    mocks.setWs({})
    await flush()
    expect(mocks.upDownCandles).toHaveBeenCalledTimes(2)
    expect(series.getState().isComplete).toBe(true)
    series.dispose()
  })

  it('keeps one retry pending when attempts are triggered early', async () => {
    vi.setSystemTime(END_MS + 60_000)
    mocks.upDownCandles.mockRejectedValue(new Error('down'))
    const series = createUpDownSeries(window)
    await flush()
    for (let i = 0; i < 5; i++) {
      series.refresh()
      await flush()
    }
    const afterRefreshes = mocks.upDownCandles.mock.calls.length
    await vi.advanceTimersByTimeAsync(15_000)

    expect(mocks.upDownCandles.mock.calls.length - afterRefreshes).toBe(1)
    series.dispose()
  })

  it('drops a response that lands after dispose', async () => {
    vi.setSystemTime(START_MS + 5_000)
    observedUpTo = START + 5
    let resolve: (value: unknown) => void = () => {}
    mocks.upDownCandles.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const series = createUpDownSeries(window)
    const listener = vi.fn()
    series.subscribe(listener)
    series.dispose()
    resolve({ code: 200, candles: [wireCandle(START)], next_cursor: 0 })
    await flush()

    expect(listener).not.toHaveBeenCalled()
    expect(mocks.actions.unsubscribeUpDownPrice).toHaveBeenCalledWith('BTC', DURATION, '1s')
  })

  it('notifies once per new live candle', async () => {
    vi.setSystemTime(START_MS + 5_000)
    observedUpTo = START + 5
    const series = createUpDownSeries(window)
    await flush()
    const listener = vi.fn()
    series.subscribe(listener)

    mocks.setLive('BTC:900:1s', [candle(START + 6)])
    mocks.setLive('BTC:900:1s', [candle(START + 6), candle(START + 7)])

    expect(listener).toHaveBeenCalledTimes(2)
    series.dispose()
  })

  it('keeps only the open of a coarse bucket that starts at the end', async () => {
    const longWindow = { ...window, duration: 14_400, endAt: START_MS + 14_400_000 }
    const end = START + 14_400
    vi.setSystemTime(longWindow.endAt + 60_000)
    mocks.upDownCandles.mockResolvedValueOnce({
      code: 200,
      candles: [
        wireCandle(end - 30, 5),
        { ...wireCandle(end, 7), high: '9', low: '6', close: '8' },
      ],
      next_cursor: 0,
    })
    const series = createUpDownSeries(longWindow)
    await flush()

    expect(series.getState().candles.at(-1)).toEqual(candle(end, 7))
    series.dispose()
  })

  it('starts a 30s window one bucket early, for the fallback price', async () => {
    vi.setSystemTime(START_MS + 60_000)
    createUpDownSeries({ ...window, duration: 14_400, endAt: START_MS + 14_400_000 }).dispose()
    await flush()

    expect(mocks.upDownCandles).toHaveBeenCalledWith(
      expect.objectContaining({ start_timestamp: START - 30 }),
      expect.anything(),
    )
  })

  it('uses 30s candles for windows longer than an hour', async () => {
    vi.setSystemTime(START_MS + 60_000)
    const series = createUpDownSeries({ ...window, duration: 14_400, endAt: START_MS + 14_400_000 })
    await flush()

    expect(series.getState().resolution).toBe('30s')
    expect(mocks.actions.subscribeUpDownPrice).toHaveBeenCalledWith('BTC', 14_400, '30s')
    series.dispose()
  })

  it('picks the resolution from the span, not the feed duration', async () => {
    vi.setSystemTime(START_MS + 60_000)
    const series = createUpDownSeries({ ...window, startAt: START_MS - 5 * 3_600_000 })
    await flush()

    expect(series.getState().resolution).toBe('30s')
    expect(mocks.actions.subscribeUpDownPrice).toHaveBeenCalledWith('BTC', DURATION, '30s')
    series.dispose()
  })
})
