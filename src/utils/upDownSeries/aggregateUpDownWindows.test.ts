import { describe, expect, it } from 'vitest'

import { aggregateUpDownWindows, mergeUpDownCandles } from './aggregateUpDownWindows'

const candle = (timestamp: number, open: number, high = open, low = open, close = open) => ({
  timestamp,
  open,
  high,
  low,
  close,
})

describe('aggregateUpDownWindows', () => {
  it('builds one candle per window, closing on the next window open', () => {
    expect(
      aggregateUpDownWindows(
        [
          candle(0, 10, 12, 9, 11),
          candle(30, 11, 14, 11, 13),
          candle(60, 15, 15, 12, 12),
          candle(90, 12, 13, 11, 11),
        ],
        0,
        60,
      ),
    ).toEqual([candle(0, 10, 15, 9, 15), candle(60, 15, 15, 11, 11)])
  })

  it('aligns to the first window and skips candles before it', () => {
    expect(aggregateUpDownWindows([candle(5, 1), candle(10, 2), candle(75, 3)], 10, 60)).toEqual([
      candle(10, 2, 3, 2, 3),
      candle(70, 3),
    ])
  })

  it('keeps the last close when the next window is missing', () => {
    expect(aggregateUpDownWindows([candle(0, 1, 2, 1, 2), candle(120, 5)], 0, 60)).toEqual([
      candle(0, 1, 2, 1, 2),
      candle(120, 5),
    ])
  })

  it('pins windows to their resolved boundary prices', () => {
    expect(
      aggregateUpDownWindows(
        [candle(0, 10, 12, 9, 11), candle(60, 15, 16, 14, 14), candle(120, 13)],
        0,
        60,
        new Map([
          [60, 14.5],
          [120, 13.5],
        ]),
      ),
    ).toEqual([
      candle(0, 10, 14.5, 9, 14.5),
      candle(60, 14.5, 16, 13.5, 13.5),
      candle(120, 13.5, 13.5, 13, 13),
    ])
  })
})

describe('mergeUpDownCandles', () => {
  it('orders the spans and keeps the later span where they share a second', () => {
    expect(
      mergeUpDownCandles([
        [candle(0, 1), candle(30, 2), candle(60, 3)],
        [candle(60, 4, 5, 4, 5), candle(90, 6)],
      ]),
    ).toEqual([candle(0, 1), candle(30, 2), candle(60, 4, 5, 4, 5), candle(90, 6)])
  })

  it('sorts spans given out of order', () => {
    expect(mergeUpDownCandles([[candle(60, 3)], [candle(0, 1)]])).toEqual([
      candle(0, 1),
      candle(60, 3),
    ])
  })
})
