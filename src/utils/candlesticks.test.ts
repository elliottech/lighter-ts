import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle, MarkPriceCandle } from 'zklighter-perps'

import type { ExtendedCandlestick } from '../store/orderbook/types'
import {
  fetchHistoricalCandlesticks,
  mergeTradeAndMarkPriceCandles,
  nextLiveCandlestick,
  withMidPriceClose,
  withMidPriceOnLiveCandlestick,
  withPreviousRange,
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

  it('widens a traded bucket to the mark price range and keeps its trade data', () => {
    expect(merge([tradeCandle(START)], [markCandle(START)])).toEqual([
      expect.objectContaining({
        time: START,
        open: 100,
        close: 102,
        high: 108,
        low: 93,
        volume: 100,
        volumeBase: 1,
        lastTradeId: 7,
      }),
    ])
  })

  it('leaves a traded bucket alone when the mark range sits inside it', () => {
    expect(merge([tradeCandle(START)], [markCandle(START, { h: 104, l: 96 })])).toEqual([
      expect.objectContaining({ high: 105, low: 95 }),
    ])
  })

  it('ignores a mark candle without tradable prices', () => {
    expect(merge([tradeCandle(START)], [markCandle(START, { h: 0, l: 0 })])).toEqual([
      expect.objectContaining({ high: 105, low: 95 }),
    ])
    expect(merge([tradeCandle(START)], [markCandle(START, { l: Number.NaN })])).toEqual([
      expect.objectContaining({ high: 105, low: 95 }),
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

  it('widens every bucket with the mark price range in default mode', async () => {
    const bars = await fetchHistoricalCandlesticks({
      period,
      marketId: 1,
      resolution: '1',
      showRawPrices: false,
    })

    expect(markPriceCandles).toHaveBeenCalledTimes(1)
    expect(bars.map((bar) => [bar.time, bar.high, bar.low, bar.volume])).toEqual([
      [OPEN - 2 * MINUTE, 108, 93, 100],
      [OPEN - MINUTE, 108, 93, 100],
      [OPEN, 108, 93, 100],
    ])
  })

  it('keeps raw prices mode on trade candles only', async () => {
    const bars = await fetchHistoricalCandlesticks({
      period,
      marketId: 1,
      resolution: '1',
      showRawPrices: true,
    })

    expect(markPriceCandles).not.toHaveBeenCalled()
    expect(bars.map((bar) => [bar.high, bar.low])).toEqual([
      [105, 95],
      [105, 95],
      [105, 95],
    ])
  })
})
