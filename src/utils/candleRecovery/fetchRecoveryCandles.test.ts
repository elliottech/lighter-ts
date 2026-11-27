import type { ExtendedCandlestick } from '../../store/orderbook/types'
import { afterEach, expect, it, vi } from 'vitest'
import { type Candle, type CandlestickApi } from 'zklighter-perps'

import { createCandleRecovery } from './createCandleRecovery'

import { fetchRecoveryCandles, mergeRecoveryOverlap } from './fetchRecoveryCandles'

const minute = 60_000
const start = 1_800_000_000_000
const candle = (t: number): Candle => ({
  t,
  o: 10,
  h: 12,
  l: 9,
  c: 11,
  O: 20,
  H: 24,
  L: 18,
  C: 22,
  v: 3,
  V: 33,
  i: 1,
})
const params = () => ({
  marketId: 1,
  resolution: '1',
  from: start,
  to: start + minute,
  showRawPrices: true,
  showMarkPriceCandles: false,
  signal: new AbortController().signal,
})
function makeApi() {
  const candles = vi
    .fn<(params: unknown, init?: unknown) => Promise<{ code: number; r: string; c: Candle[] }>>()
    .mockResolvedValue({ code: 200, r: '1m', c: [candle(start)] })
  const markPriceCandles = vi
    .fn<
      (
        params: unknown,
        init?: unknown,
      ) => Promise<{
        code: number
        r: string
        c: { t: number; o: number; h: number; l: number; c: number }[]
      }>
    >()
    .mockResolvedValue({ code: 200, r: '1m', c: [{ t: start, o: 10, h: 15, l: 8, c: 12 }] })
  return { candles, markPriceCandles }
}

it('fetches raw candles with the shared conversion and forwards cancellation', async () => {
  const api = makeApi()
  const options = params()
  const bars = await fetchRecoveryCandles({
    ...options,
    api: api as unknown as CandlestickApi,
  })
  expect(bars[0]).toMatchObject({
    time: start,
    open: 20,
    high: 24,
    low: 18,
    close: 22,
    volume: 33,
  })
  expect(api.markPriceCandles).not.toHaveBeenCalled()
  expect((api.candles.mock.calls[0]![1] as { signal: AbortSignal }).signal).toBeInstanceOf(
    AbortSignal,
  )
})

it('uses mark-price OHLC and trade volume when mark mode is enabled', async () => {
  const api = makeApi()
  const bars = await fetchRecoveryCandles({
    ...params(),
    showMarkPriceCandles: true,
    api: api as unknown as CandlestickApi,
  })
  expect(bars[0]).toMatchObject({
    open: 10,
    high: 15,
    low: 8,
    close: 12,
    volume: 33,
  })
})

it('keeps traded buckets on trade candles in the default display mode', async () => {
  const api = makeApi()
  const bars = await fetchRecoveryCandles({
    ...params(),
    showRawPrices: false,
    api: api as unknown as CandlestickApi,
  })
  expect(bars[0]).toMatchObject({
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 33,
  })
})

it('walks all windows for long outages, including empty windows and inclusive endpoints', async () => {
  const api = makeApi()
  api.candles.mockResolvedValueOnce({
    code: 200,
    r: '1m',
    c: [candle(start), candle(start + 499 * minute)],
  })
  api.candles.mockResolvedValueOnce({ code: 200, r: '1m', c: [] })
  api.candles.mockResolvedValueOnce({
    code: 200,
    r: '1m',
    c: [candle(start + 1000 * minute)],
  })
  const bars = await fetchRecoveryCandles({
    ...params(),
    to: start + 1001 * minute,
    api: api as unknown as CandlestickApi,
  })
  expect(api.candles).toHaveBeenCalledTimes(3)
  expect(api.candles.mock.calls[1]![0]).toMatchObject({
    start_timestamp: start + 499 * minute,
    count_back: 500,
  })
  expect(bars.map((bar) => bar.time)).toEqual([start, start + 1000 * minute])
})

it('rejects the whole result if a later page fails', async () => {
  const api = makeApi()
  api.candles.mockResolvedValueOnce({ code: 200, r: '1m', c: [candle(start)] })
  api.candles.mockRejectedValueOnce(new Error('network'))
  await expect(
    fetchRecoveryCandles({
      ...params(),
      to: start + 1000 * minute,
      api: api as unknown as CandlestickApi,
    }),
  ).rejects.toThrow('network')
})

it('rejects API errors even on a successful HTTP response', async () => {
  const api = makeApi()
  api.candles.mockResolvedValue({ code: 500, r: '1m', c: [] })
  await expect(
    fetchRecoveryCandles({
      ...params(),
      api: api as unknown as CandlestickApi,
    }),
  ).rejects.toThrow('Candle recovery failed')
})

it('sizes windows using the underlying resolution for rebuilt TradingView intervals', async () => {
  const api = makeApi()
  await fetchRecoveryCandles({
    ...params(),
    resolution: '3',
    to: start + 500 * minute,
    api: api as unknown as CandlestickApi,
  })
  expect(api.candles).toHaveBeenCalledTimes(2)
  expect(api.candles.mock.calls[0]![0]).toMatchObject({
    resolution: '1m',
    end_timestamp: start + 499 * minute,
  })
})

it('reconciles a newer live trade without losing snapshot range or volume', () => {
  const snapshot = {
    time: start,
    open: 10,
    high: 14,
    low: 8,
    close: 11,
    volume: 30,
    volumeBase: 3,
    lastTradeId: 4,
    marketId: 1,
    resolution: '1m',
  } satisfies ExtendedCandlestick
  expect(
    mergeRecoveryOverlap(snapshot, {
      ...snapshot,
      high: 13,
      low: 9,
      close: 12,
      lastTradeId: 5,
      volume: 40,
    }),
  ).toMatchObject({ close: 12, high: 14, low: 8, volume: 40, lastTradeId: 5 })
  expect(mergeRecoveryOverlap(snapshot, { ...snapshot, close: 1, lastTradeId: 3 })).toMatchObject({
    close: 11,
    lastTradeId: 4,
  })
})

afterEach(() => vi.useRealTimers())
it('aborts a hung page after 5 seconds rather than returning partial history', async () => {
  vi.useFakeTimers()
  const api = makeApi()
  api.candles.mockImplementation(
    (_params, init) =>
      new Promise((_resolve, reject) => {
        const { signal } = init as { signal: AbortSignal }
        signal.addEventListener('abort', () => reject(new Error('timeout')))
      }),
  )
  const result = fetchRecoveryCandles({
    ...params(),
    api: api as unknown as CandlestickApi,
  })
  const assertion = expect(result).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(5_000)
  await assertion
})

it.each([
  {
    name: 'newer open trade checkpoint',
    time: start,
    checkpointId: 2,
    snapshotId: 1,
    close: 105,
    high: 106,
  },
  {
    name: 'closed checkpoint',
    time: start - minute,
    checkpointId: 2,
    snapshotId: 1,
    close: 103,
    high: 104,
  },
  {
    name: 'equal-ID mark checkpoint',
    time: start,
    checkpointId: 0,
    snapshotId: 0,
    close: 103,
    high: 106,
  },
])(
  'reconciles $name without a websocket tick during refresh',
  async ({ time, checkpointId, snapshotId, close, high }) => {
    const base: ExtendedCandlestick = {
      time,
      open: 100,
      close: 105,
      high: 106,
      low: 99,
      volume: 50,
      marketId: 1,
      resolution: '1m',
      lastTradeId: checkpointId,
    }
    const snapshot = { ...base, close: 103, high: 104, volume: 30, lastTradeId: snapshotId }
    const emit = vi.fn((b: ExtendedCandlestick) => b)
    const c = createCandleRecovery({
      initialBar: base,
      connected: true,
      intervalMs: minute,
      now: () => start + 30000,
      fetchBars: () => Promise.resolve([snapshot]),
      emit,
      onError: vi.fn(),
      mergeOverlap: mergeRecoveryOverlap,
    })
    c.setConnected(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ close, high, volume: time === start ? 50 : 30 }),
      true,
    )
    c.dispose()
  },
)

it('keeps the default-mode mid-price close on an equal-ID checkpoint, but lets buffered mark closes win ties', () => {
  const base: ExtendedCandlestick = {
    time: start,
    open: 100,
    close: 103,
    high: 104,
    low: 99,
    volume: 30,
    marketId: 1,
    resolution: '1m',
    lastTradeId: 1,
  }
  const live = { ...base, close: 105, high: 106, volume: 50 }
  expect(mergeRecoveryOverlap(base, live, 'checkpoint', true)).toMatchObject({
    close: 105,
    high: 106,
    volume: 50,
  })
  expect(
    mergeRecoveryOverlap({ ...base, lastTradeId: 0 }, { ...live, lastTradeId: 0 }, 'buffered'),
  ).toMatchObject({ close: 105 })
})

it.each([false, true])(
  'does not seed recovery extrema from a REST predecessor in mark=%s mode',
  async (mark) => {
    const api = makeApi()
    api.candles.mockResolvedValue({
      code: 200,
      r: '1m',
      c: [{ ...candle(start - minute), c: 7, C: 7 }, candle(start), candle(start + minute)],
    })
    api.markPriceCandles.mockResolvedValue({
      code: 200,
      r: '1m',
      c: [
        { t: start - minute, o: 8, h: 9, l: 6, c: 7 },
        { t: start, o: 10, h: 12, l: 9, c: 11 },
        { t: start + minute, o: 14, h: 15, l: 12, c: 13 },
      ],
    })
    const bars = await fetchRecoveryCandles({
      ...params(),
      to: start + 2 * minute,
      showRawPrices: false,
      showMarkPriceCandles: mark,
      api: api as unknown as CandlestickApi,
    })
    expect(bars.map((b) => b.time)).toEqual([start, start + minute])
    expect(bars[0]?.low).toBeGreaterThan(7)
    expect(api.candles.mock.calls[0]?.[0]).toMatchObject({ start_timestamp: start })
  },
)

it('keeps raw recovery opens unchanged and does not request a predecessor', async () => {
  const api = makeApi()
  api.candles.mockResolvedValue({
    code: 200,
    r: '1m',
    c: [{ ...candle(start - minute), C: 7 }, candle(start)],
  })
  const bars = await fetchRecoveryCandles({ ...params(), api: api as unknown as CandlestickApi })
  expect(api.candles.mock.calls[0]?.[0]).toMatchObject({ start_timestamp: start })
  expect(bars).toHaveLength(1)
  expect(bars[0]?.open).toBe(20)
})

it('paginates raw source ranges without duplicating boundaries', async () => {
  const api = makeApi()
  const response = (input: unknown) => {
    const { start_timestamp: from, end_timestamp: to } = input as {
      start_timestamp: number
      end_timestamp: number
    }
    return Promise.resolve({
      code: 200,
      r: '1m',
      c: Array.from({ length: (to - from) / minute + 1 }, (_, i) => candle(from + i * minute)),
    })
  }
  api.candles.mockImplementation(response)
  api.markPriceCandles.mockImplementation(response)
  const bars = await fetchRecoveryCandles({
    ...params(),
    to: start + 500 * minute,
    showRawPrices: false,
    api: api as unknown as CandlestickApi,
  })
  expect(bars.map((b) => b.time)).toEqual(Array.from({ length: 500 }, (_, i) => start + i * minute))
  expect(bars.every((b) => b.open === bars[0]?.open)).toBe(true)
})

it('does not fetch a predecessor for an empty recovery range', async () => {
  const api = makeApi()
  expect(
    await fetchRecoveryCandles({
      ...params(),
      to: start,
      showRawPrices: false,
      api: api as unknown as CandlestickApi,
    }),
  ).toEqual([])
  expect(api.candles).not.toHaveBeenCalled()
})
