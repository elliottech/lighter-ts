import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle, MarkPriceCandle } from 'zklighter-perps'

import type { ExtendedCandlestick } from '../store/orderbook/types'
import {
  fetchHistoricalCandlesticks,
  obResToResInMiliseconds,
  tvResToObRes,
  nextLiveCandlestick,
  withMidPriceClose,
  withMidPriceOnLiveCandlestick,
  withPreviousRange,
  mergeTradeAndMarkPriceCandles,
} from './candlesticks'
import { apis } from '../lib/apis'

const MINUTE = 60_000
const START = 1_700_000_040_000

const bar = (time: number, overrides: Partial<ExtendedCandlestick> = {}): ExtendedCandlestick => ({
  time,
  open: 100,
  high: 105,
  low: 95,
  close: 102,
  volume: 10,
  volumeBase: 1,
  lastTradeId: 7,
  marketId: 1,
  resolution: '1m',
  ...overrides,
})

describe('withMidPriceClose', () => {
  it('moves the close to the mid price and widens the range around it', () => {
    expect(withMidPriceClose(bar(START), 110)).toMatchObject({ close: 110, high: 110, low: 95 })
    expect(withMidPriceClose(bar(START), 90)).toMatchObject({ close: 90, high: 105, low: 90 })
    expect(withMidPriceClose(bar(START), 101)).toMatchObject({ close: 101, high: 105, low: 95 })
  })

  it('returns the same bar without a tradable mid price or when it already closes there', () => {
    const current = bar(START)
    expect(withMidPriceClose(current, undefined)).toBe(current)
    expect(withMidPriceClose(current, 0)).toBe(current)
    expect(withMidPriceClose(current, -1)).toBe(current)
    expect(withMidPriceClose(current, Number.NaN)).toBe(current)
    expect(withMidPriceClose(current, Number.POSITIVE_INFINITY)).toBe(current)
    expect(withMidPriceClose(current, 102)).toBe(current)
  })
})

describe('withMidPriceOnLiveCandlestick', () => {
  const bars = [bar(START - MINUTE, { close: 100 }), bar(START)]

  it('folds the mid price into the last bar while its bucket is open', () => {
    const result = withMidPriceOnLiveCandlestick(bars, 110, START + 30_000)
    expect(result[0]).toBe(bars[0])
    expect(result[1]).toMatchObject({ time: START, close: 110, high: 110, low: 95 })
    expect(bars[1]).toMatchObject({ close: 102 })
  })

  it('leaves a closed last bar alone', () => {
    expect(withMidPriceOnLiveCandlestick(bars, 110, START + MINUTE)).toBe(bars)
  })

  it('ignores bars that have not started and empty input', () => {
    expect(withMidPriceOnLiveCandlestick(bars, 110, START - 1)).toBe(bars)
    expect(withMidPriceOnLiveCandlestick([], 110, START)).toEqual([])
  })

  it('does nothing without a tradable mid price', () => {
    expect(withMidPriceOnLiveCandlestick(bars, undefined, START)).toBe(bars)
    expect(withMidPriceOnLiveCandlestick(bars, 0, START)).toBe(bars)
    expect(withMidPriceOnLiveCandlestick(bars, Number.NaN, START)).toBe(bars)
  })

  it('sizes the open bucket by the candle resolution', () => {
    const hourly = [bar(START, { resolution: '1h' })]
    expect(withMidPriceOnLiveCandlestick(hourly, 110, START + 59 * MINUTE)[0]).toMatchObject({
      close: 110,
    })
    expect(withMidPriceOnLiveCandlestick(hourly, 110, START + 60 * MINUTE)).toBe(hourly)
  })
})

describe('nextLiveCandlestick', () => {
  const last = bar(START)

  it('re-closes the open bucket at the mid price', () => {
    expect(nextLiveCandlestick(last, 110, START + 30_000)).toMatchObject({
      time: START,
      close: 110,
      high: 110,
      low: 95,
    })
  })

  it('returns null when the open bucket already closes at the mid price or there is no mid', () => {
    expect(nextLiveCandlestick(last, 102, START + 30_000)).toBeNull()
    expect(nextLiveCandlestick(last, undefined, START + 30_000)).toBeNull()
    expect(nextLiveCandlestick(last, 0, START + 30_000)).toBeNull()
    expect(nextLiveCandlestick(last, Number.NaN, START + MINUTE)).toBeNull()
  })

  it('opens the next bucket flat at the mid price', () => {
    expect(nextLiveCandlestick(last, 110, START + MINUTE + 5_000)).toEqual({
      time: START + MINUTE,
      open: 110,
      high: 110,
      low: 110,
      close: 110,
      volume: 0,
      volumeBase: 0,
      lastTradeId: 7,
      marketId: 1,
      resolution: '1m',
    })
  })

  it('opens the bucket that contains now flat at the mid price after a gap', () => {
    expect(nextLiveCandlestick(last, 110, START + 2 * MINUTE + 5_000)).toMatchObject({
      time: START + 2 * MINUTE,
      open: 110,
      high: 110,
      low: 110,
      close: 110,
    })
    expect(
      nextLiveCandlestick(bar(START, { resolution: '1h' }), 90, START + 26 * 60 * MINUTE),
    ).toMatchObject({ time: START + 26 * 60 * MINUTE, open: 90, high: 90, low: 90, close: 90 })
  })

  it('opens a flat bucket when the mid price equals the previous close', () => {
    expect(nextLiveCandlestick(last, 102, START + MINUTE)).toMatchObject({
      time: START + MINUTE,
      open: 102,
      high: 102,
      low: 102,
      close: 102,
    })
  })

  it('returns null before the last bar starts or for an unknown resolution', () => {
    expect(nextLiveCandlestick(last, 110, START - 1)).toBeNull()
    expect(nextLiveCandlestick(bar(START, { resolution: '7m' }), 110, START)).toBeNull()
  })
})

describe('withPreviousRange', () => {
  it('keeps the range the same bucket already reached', () => {
    const previous = bar(START, { high: 110, low: 90 })
    expect(withPreviousRange(bar(START, { high: 106, low: 96 }), previous)).toMatchObject({
      high: 110,
      low: 90,
      close: 102,
    })
  })

  it('returns the same bar when the range is already covered or the bucket differs', () => {
    const current = bar(START, { high: 112, low: 88 })
    expect(withPreviousRange(current, bar(START, { high: 110, low: 90 }))).toBe(current)
    expect(withPreviousRange(current, bar(START - MINUTE, { high: 200, low: 1 }))).toBe(current)
    expect(withPreviousRange(current, undefined)).toBe(current)
  })
})

const tradeCandle = (t: number, overrides: Partial<Candle> = {}): Candle => ({
  t,
  o: 100,
  h: 105,
  l: 95,
  c: 102,
  O: 0,
  H: 0,
  L: 0,
  C: 0,
  v: 1,
  V: 100,
  i: 7,
  ...overrides,
})

const markCandle = (t: number, overrides: Partial<MarkPriceCandle> = {}): MarkPriceCandle => ({
  t,
  o: 101,
  h: 108,
  l: 93,
  c: 103,
  sc: 3,
  ...overrides,
})

describe('mergeTradeAndMarkPriceCandles', () => {
  const merge = (trades: Candle[], marks: MarkPriceCandle[]) =>
    mergeTradeAndMarkPriceCandles(trades, marks, 1, '1m')

  it('keeps a traded bucket as the trade candle', () => {
    expect(merge([tradeCandle(START)], [markCandle(START)])).toEqual([
      expect.objectContaining({
        time: START,
        open: 100,
        close: 102,
        high: 105,
        low: 95,
        volume: 100,
        volumeBase: 1,
        lastTradeId: 7,
      }),
    ])
  })

  it('uses the mark candle for a bucket without trades and passes single-source buckets through', () => {
    expect(
      merge(
        [tradeCandle(START - MINUTE, { v: 0, V: 0 }), tradeCandle(START + MINUTE)],
        [markCandle(START - MINUTE), markCandle(START)],
      ),
    ).toEqual([
      expect.objectContaining({
        time: START - MINUTE,
        open: 101,
        high: 108,
        low: 93,
        close: 103,
        volume: 0,
      }),
      expect.objectContaining({ time: START, open: 101, close: 103 }),
      expect.objectContaining({ time: START + MINUTE, high: 105, low: 95, volume: 100 }),
    ])
  })

  it('keeps an empty trade candle when there is no mark candle for its bucket', () => {
    expect(merge([tradeCandle(START, { v: 0, V: 0 })], [])).toEqual([
      expect.objectContaining({
        time: START,
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 0,
      }),
    ])
  })
})

describe('fetchHistoricalCandlesticks', () => {
  const OPEN = 1_788_000_000_000
  const candles = vi.fn()
  const markPriceCandles = vi.fn()
  const period = { from: (OPEN - 2 * MINUTE) / 1000, to: (OPEN + MINUTE) / 1000, countBack: 3 }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(OPEN + 10_000)
    candles.mockReset()
    markPriceCandles.mockReset()
    candles.mockResolvedValue({
      c: [-2, -1, 0].map((offset) => tradeCandle(OPEN + offset * MINUTE)),
    })
    markPriceCandles.mockResolvedValue({
      c: [-2, -1, 0].map((offset) => markCandle(OPEN + offset * MINUTE)),
    })
    apis.candlesticksApi = { candles, markPriceCandles } as never
  })

  afterEach(() => {
    apis.candlesticksApi = null!
    vi.useRealTimers()
  })

  it.each([
    { mode: 'Default', showRawPrices: false, showMarkPriceCandles: false },
    { mode: 'Raw', showRawPrices: true, showMarkPriceCandles: false },
    { mode: 'Mark', showRawPrices: false, showMarkPriceCandles: true },
  ])('never requests past now in $mode mode', async ({ showRawPrices, showMarkPriceCandles }) => {
    await fetchHistoricalCandlesticks({
      period: { ...period, to: (OPEN + 86400000) / 1000 },
      marketId: 1,
      resolution: '1',
      showRawPrices,
      showMarkPriceCandles,
    })
    for (const [request] of [...candles.mock.calls, ...markPriceCandles.mock.calls])
      expect(request).toMatchObject({ end_timestamp: OPEN + 10_000 })
  })

  it('keeps a past end as requested', async () => {
    await fetchHistoricalCandlesticks({
      period: { ...period, to: (OPEN - MINUTE) / 1000 },
      marketId: 1,
      resolution: '1',
      showRawPrices: false,
    })
    expect(candles.mock.calls[0]![0]).toMatchObject({ end_timestamp: OPEN - MINUTE })
  })

  it.each(['1W', '1M'])(
    'loads a %s chart whose stored rows skip a weekend before the edge window',
    async (resolution) => {
      const DAY = 86400000
      const listing = Date.UTC(2025, 4, 29)
      const now = Date.UTC(2026, 9, 13, 10)
      vi.setSystemTime(now)
      const weekend = [Date.UTC(2025, 4, 31), Date.UTC(2025, 5, 1)]
      const stored: number[] = []
      for (let t = listing; t <= now; t += DAY) if (!weekend.includes(t)) stored.push(t)
      // Edge: 500 days ending one bucket after `end`. Backend: clamps to now,
      // fills gaps inside the window, pads a short window with stored rows.
      candles.mockImplementation((request: { end_timestamp: number }) => {
        const edgeEnd = Math.floor(request.end_timestamp / DAY) * DAY + DAY
        const start = Math.max(edgeEnd - 500 * DAY, listing)
        const filled: number[] = []
        for (let t = start; t < Math.min(edgeEnd, now); t += DAY) filled.push(t)
        const padding =
          filled.length < 500 ? stored.filter((t) => t < start).slice(filled.length - 500) : []
        return Promise.resolve({ code: 200, c: [...padding, ...filled].map((t) => tradeCandle(t)) })
      })
      const bars = await fetchHistoricalCandlesticks({
        marketId: 1,
        resolution,
        showRawPrices: false,
        completeBoundary: true,
        strict: true,
        period: {
          from: Date.UTC(2020, 11, 28) / 1000,
          to: (Math.floor(now / DAY) * DAY + DAY) / 1000,
          countBack: 300,
        },
      })
      const times = bars.map((bar) => bar.time)
      expect(times[0]).toBe(listing)
      expect(times.at(-1)).toBe(Math.floor(now / DAY) * DAY)
      expect(times.every((t, i) => i === 0 || t - times[i - 1]! === DAY)).toBe(true)
    },
  )

  it('completes an optimized leading display bucket and its continuous predecessor', async () => {
    const start = Math.floor(OPEN / (3 * MINUTE)) * 3 * MINUTE
    vi.setSystemTime(start + 10 * MINUTE)
    const source = [-1, 0, 1, 2, 3].map((offset) => ({
      ...tradeCandle(start + offset * MINUTE),
      o: 100 + offset,
      c: 101 + offset,
    }))
    candles
      .mockResolvedValueOnce({ c: source.slice(2) })
      .mockResolvedValueOnce({ c: source.slice(0, 4) })
    markPriceCandles.mockResolvedValue({ c: [] })
    const bars = await fetchHistoricalCandlesticks({
      period: { from: (start - 3 * MINUTE) / 1000, to: (start + 4 * MINUTE) / 1000, countBack: 3 },
      marketId: 1,
      resolution: '3',
      showRawPrices: false,
      completeBoundary: true,
    })
    expect(bars.map((bar) => bar.time)).toEqual(source.slice(1).map((bar) => bar.t))
    expect(bars[0]?.open).toBe(source[0]!.c)
    expect(candles).toHaveBeenCalledTimes(2)
    expect(candles.mock.calls[1]![0]).toMatchObject({
      resolution: '1m',
      start_timestamp: start - MINUTE,
      end_timestamp: start + MINUTE,
      count_back: 3,
    })
  })

  it.each(
    ['3', '120', '480', '3D', '1W', '1M'].flatMap((resolution) =>
      ['Default', 'Raw', 'Mark'].map((mode) => ({ resolution, mode })),
    ),
  )(
    'repairs optimized $resolution / $mode leading source candles',
    async ({ resolution, mode }) => {
      const start = Date.UTC(2025, 8, 1) // Monday and a 3D year boundary
      const step = obResToResInMiliseconds(tvResToObRes(resolution))
      vi.setSystemTime(start + 40 * 86400000)
      const source = [-1, 0, 1, 2, 3].map((offset) => ({
        ...tradeCandle(start + offset * step),
        o: 100 + offset,
        h: 110 + offset,
        l: 90 + offset,
        c: 101 + offset,
      }))
      const backend = () => {
        let initial = true
        return vi.fn(
          (request: { start_timestamp: number; end_timestamp: number; count_back: number }) => {
            if (initial) {
              initial = false
              return Promise.resolve({ c: source.slice(2) })
            }
            return Promise.resolve({
              c: source.filter((bar) => bar.t <= request.end_timestamp).slice(-request.count_back),
            })
          },
        )
      }
      candles.mockImplementation(backend())
      markPriceCandles.mockImplementation(backend())
      const result = await fetchHistoricalCandlesticks({
        marketId: 1,
        resolution,
        showRawPrices: mode === 'Raw',
        showMarkPriceCandles: mode === 'Mark',
        completeBoundary: true,
        period: {
          from: (start - 40 * 86400000) / 1000,
          to: (start + 3 * step) / 1000,
          countBack: 3,
        },
      })
      expect(result.map((bar) => bar.time)).toEqual(source.slice(1).map((bar) => bar.t))
      expect(result[0]).toMatchObject({ open: 100, high: 110, low: 90, close: 101 })
      expect(new Set(result.map((bar) => bar.time)).size).toBe(result.length)
    },
  )

  it.each(
    ['Default', 'Raw', 'Mark'].flatMap((mode) =>
      [
        [0, 2, 3],
        [0, 3],
      ].map((offsets) => ({ mode, offsets })),
    ),
  )(
    'rejects missing sources after an aligned first bar: $mode $offsets',
    async ({ mode, offsets }) => {
      const start = Math.floor(OPEN / (3 * MINUTE)) * 3 * MINUTE
      vi.setSystemTime(start + 10 * MINUTE)
      const rows = offsets.map((offset) => tradeCandle(start + offset * MINUTE))
      const prefix = [-1, 0].map((offset) => tradeCandle(start + offset * MINUTE))
      candles.mockResolvedValueOnce({ c: rows }).mockResolvedValue({ c: prefix })
      markPriceCandles.mockResolvedValueOnce({ c: rows }).mockResolvedValue({ c: prefix })
      await expect(
        fetchHistoricalCandlesticks({
          marketId: 1,
          resolution: '3',
          completeBoundary: true,
          showRawPrices: mode === 'Raw',
          showMarkPriceCandles: mode === 'Mark',
          period: { from: start / 1000, to: (start + 4 * MINUTE) / 1000, countBack: 4 },
        }),
      ).rejects.toThrow('Incomplete candle history boundary')
    },
  )

  it.each(['live', 'late listing'])('allows a contiguous %s leading bucket', async (kind) => {
    const start = Math.floor(OPEN / (3 * MINUTE)) * 3 * MINUTE
    vi.setSystemTime(start + (kind === 'live' ? 1 : 10) * MINUTE + 10000)
    const offsets = kind === 'live' ? [0, 1] : [1, 2, 3]
    candles.mockImplementation((request: { start_timestamp: number; end_timestamp: number }) =>
      Promise.resolve({
        c: offsets
          .map((offset) => tradeCandle(start + offset * MINUTE))
          .filter((bar) => bar.t >= request.start_timestamp && bar.t <= request.end_timestamp),
      }),
    )
    const result = await fetchHistoricalCandlesticks({
      marketId: 1,
      resolution: '3',
      completeBoundary: true,
      showRawPrices: true,
      period: { from: start / 1000, to: (start + 4 * MINUTE) / 1000, countBack: 4 },
    })
    expect(result.map((bar) => bar.time)).toEqual(offsets.map((offset) => start + offset * MINUTE))
  })

  it.each(['Default', 'Raw', 'Mark'])(
    'ignores an out-of-window trade outlier before validating %s history',
    async (mode) => {
      const start = Math.floor(OPEN / (3 * MINUTE)) * 3 * MINUTE
      vi.setSystemTime(start + 10 * MINUTE)
      const tail = Array.from({ length: 12 }, (_, i) => tradeCandle(start + (i - 6) * MINUTE))
      const stray = tradeCandle(start - 300 * MINUTE)
      let firstTrade = true
      let firstMark = true
      candles.mockImplementation((request: { end_timestamp: number; count_back: number }) => {
        const c = firstTrade
          ? [stray, ...tail]
          : tail.filter((b) => b.t <= request.end_timestamp).slice(-request.count_back)
        firstTrade = false
        return Promise.resolve({ c })
      })
      markPriceCandles.mockImplementation(
        (request: { end_timestamp: number; count_back: number }) => {
          const c = firstMark
            ? tail.slice(2)
            : tail.filter((b) => b.t <= request.end_timestamp).slice(-request.count_back)
          firstMark = false
          return Promise.resolve({ c })
        },
      )
      const result = await fetchHistoricalCandlesticks({
        marketId: 1,
        resolution: '3',
        showRawPrices: mode === 'Raw',
        showMarkPriceCandles: mode === 'Mark',
        completeBoundary: true,
        period: { from: start / 1000, to: (start + 5 * MINUTE) / 1000, countBack: 2 },
      })
      expect(result.map((b) => b.time)).toEqual(tail.filter((b) => b.t >= start).map((b) => b.t))
      expect(result[0]?.volume).toBe(tail[6]!.V)
    },
  )

  it('does not publish an incomplete bucket when boundary fetching fails', async () => {
    candles
      .mockResolvedValueOnce({ code: 200, c: [tradeCandle(OPEN)] })
      .mockRejectedValueOnce(new Error('boundary unavailable'))
    await expect(
      fetchHistoricalCandlesticks({
        period,
        marketId: 1,
        resolution: '3',
        showRawPrices: true,
        completeBoundary: true,
        strict: true,
      }),
    ).rejects.toThrow('boundary unavailable')
  })

  it('does not issue a boundary request after cancellation', async () => {
    const controller = new AbortController()
    candles.mockImplementationOnce(() => {
      controller.abort()
      return Promise.resolve({ c: [tradeCandle(OPEN)] })
    })
    await expect(
      fetchHistoricalCandlesticks({
        period,
        marketId: 1,
        resolution: '3',
        showRawPrices: true,
        completeBoundary: true,
        strict: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(candles).toHaveBeenCalledTimes(1)
  })

  it('requests backend-merged candles in default mode and connects opens across pages', async () => {
    candles.mockResolvedValue({
      c: [
        tradeCandle(OPEN - 2 * MINUTE),
        tradeCandle(OPEN - MINUTE, { o: 120, h: 125, l: 118, c: 121, v: 0, V: 0, i: 0 }),
        tradeCandle(OPEN, { o: 121, h: 121, l: 110, c: 115 }),
      ],
    })

    const bars = await fetchHistoricalCandlesticks({
      period,
      marketId: 1,
      resolution: '1',
      showRawPrices: false,
    })

    expect(markPriceCandles).not.toHaveBeenCalled()
    expect(candles).toHaveBeenCalledTimes(1)
    expect(candles.mock.calls[0]![0]).toMatchObject({ merge_mark_price: true })
    expect(
      bars.map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]),
    ).toEqual([
      [OPEN - 2 * MINUTE, 100, 105, 95, 102, 100],
      [OPEN - MINUTE, 102, 125, 102, 121, 0],
      [OPEN, 121, 121, 110, 115, 100],
    ])
  })

  it.each(['Default', 'Raw', 'Mark'])(
    'skips the boundary round for an aligned %s page, which the backend already connects',
    async (mode) => {
      const bars = await fetchHistoricalCandlesticks({
        period,
        marketId: 1,
        resolution: '1',
        showRawPrices: mode === 'Raw',
        showMarkPriceCandles: mode === 'Mark',
        completeBoundary: true,
      })

      expect(candles).toHaveBeenCalledTimes(1)
      expect(markPriceCandles).toHaveBeenCalledTimes(mode === 'Mark' ? 1 : 0)
      expect(bars.map((bar) => bar.time)).toEqual([OPEN - 2 * MINUTE, OPEN - MINUTE, OPEN])
    },
  )

  it('asks the backend to connect mark candle opens in mark mode', async () => {
    await fetchHistoricalCandlesticks({
      period,
      marketId: 1,
      resolution: '1',
      showRawPrices: false,
      showMarkPriceCandles: true,
    })

    expect(markPriceCandles.mock.calls[0]![0]).toMatchObject({ connect_opens: true })
    expect(candles.mock.calls[0]![0]).not.toHaveProperty('merge_mark_price')
  })

  it('keeps raw prices mode on trade candles only', async () => {
    const bars = await fetchHistoricalCandlesticks({
      period,
      marketId: 1,
      resolution: '1',
      showRawPrices: true,
    })

    expect(markPriceCandles).not.toHaveBeenCalled()
    expect(candles.mock.calls[0]![0]).not.toHaveProperty('merge_mark_price')
    expect(bars.map((bar) => [bar.high, bar.low])).toEqual([
      [105, 95],
      [105, 95],
      [105, 95],
    ])
  })
  it('allows a slow multi-page load while timing out each stalled page', async () => {
    const signals: AbortSignal[] = []
    candles.mockImplementation(
      (params: { count_back: number; end_timestamp: number }, init: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          signals.push(init.signal)
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Timed out', 'AbortError')),
          )
          setTimeout(
            () =>
              resolve({
                code: 200,
                c: Array.from({ length: params.count_back }, (_, i) =>
                  tradeCandle(params.end_timestamp - (params.count_back - i) * MINUTE),
                ),
              }),
            10000,
          )
        }),
    )
    const pending = fetchHistoricalCandlesticks({
      period: { from: (OPEN - 1000 * MINUTE) / 1000, to: OPEN / 1000, countBack: 1000 },
      marketId: 1,
      resolution: '1',
      showRawPrices: true,
      strict: true,
    })
    await vi.advanceTimersByTimeAsync(20000)
    await expect(pending).resolves.toHaveLength(1000)
    expect(candles).toHaveBeenCalledTimes(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    candles.mockImplementation(
      (_params: unknown, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Timed out', 'AbortError')),
          )
        }),
    )
    const stalled = fetchHistoricalCandlesticks({
      period,
      marketId: 1,
      resolution: '1',
      showRawPrices: true,
      strict: true,
    })
    const rejection = expect(stalled).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(15000)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([false, true])(
    'does not count inclusive page boundaries twice (mark=%s)',
    async (mark) => {
      const response = (params: { count_back: number; end_timestamp: number }) => {
        const last = Math.floor(params.end_timestamp / MINUTE) * MINUTE
        return Promise.resolve({
          code: 200,
          c: Array.from({ length: params.count_back }, (_, i) =>
            tradeCandle(last - (params.count_back - 1 - i) * MINUTE),
          ),
        })
      }
      candles.mockImplementation(response)
      markPriceCandles.mockImplementation(response)
      const result = await fetchHistoricalCandlesticks({
        period: { from: (OPEN - 1000 * MINUTE) / 1000, to: OPEN / 1000, countBack: 1000 },
        marketId: 1,
        resolution: '1',
        showRawPrices: !mark,
        showMarkPriceCandles: mark,
        strict: true,
      })
      expect(result).toHaveLength(1000)
      expect(new Set(result.map((bar) => bar.time)).size).toBe(1000)
      expect(result[0]?.time).toBe(OPEN - 999 * MINUTE)
      expect(result.every((bar, i) => i === 0 || bar.time - result[i - 1]!.time === MINUTE)).toBe(
        true,
      )
    },
  )
  it.each(['trade', 'mark'] as const)(
    'aborts the paired paginator after a source failure in mark mode (failed=%s)',
    async (failed) => {
      let siblingSignal: AbortSignal | undefined
      let finish: (() => void) | undefined
      const failure = failed === 'trade' ? candles : markPriceCandles
      const sibling = failed === 'trade' ? markPriceCandles : candles
      failure.mockRejectedValue(new Error('source failed'))
      sibling.mockImplementation((_params: unknown, init: { signal: AbortSignal }) => {
        siblingSignal = init.signal
        // Even a transport that ignores abort must not start its next page later.
        return new Promise((resolve) => {
          finish = () =>
            resolve({
              code: 200,
              c: Array.from({ length: 500 }, (_, i) => tradeCandle(OPEN - (500 - i) * MINUTE)),
            })
        })
      })
      const parent = new AbortController()
      const add = vi.spyOn(parent.signal, 'addEventListener')
      const remove = vi.spyOn(parent.signal, 'removeEventListener')
      await expect(
        fetchHistoricalCandlesticks({
          period: { from: (OPEN - 1000 * MINUTE) / 1000, to: OPEN / 1000, countBack: 1000 },
          marketId: 1,
          resolution: '1',
          showRawPrices: false,
          showMarkPriceCandles: true,
          strict: true,
          signal: parent.signal,
        }),
      ).rejects.toThrow('source failed')
      finish?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(siblingSignal?.aborted).toBe(true)
      expect(parent.signal.aborted).toBe(false)
      expect(sibling).toHaveBeenCalledTimes(1)
      expect(remove.mock.calls.length).toBe(add.mock.calls.length)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
