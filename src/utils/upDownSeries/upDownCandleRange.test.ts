import { describe, expect, it } from 'vitest'

import {
  getUpDownCandlePages,
  getUpDownCandleRange,
  getUpDownChartDomain,
} from './upDownCandleRange'

describe('getUpDownChartDomain', () => {
  it('spans the window in seconds on the resolution grid', () => {
    expect(getUpDownChartDomain(60_000, 960_000, '1s')).toEqual({ from: 60, to: 960, step: 1 })
    expect(getUpDownChartDomain(0, 14_400_000, '30s')).toEqual({ from: 0, to: 14_400, step: 30 })
  })
})

describe('getUpDownCandleRange', () => {
  const event = { start_at: 900_000, end_at: 1_800_000 }

  it('ends with the event once it has started, in five-minute candles', () => {
    expect(getUpDownCandleRange(event, true, 3)).toEqual({
      startAt: 900_000,
      endAt: 1_800_000,
      domain: { from: 900, to: 1_500, step: 300 },
    })
  })

  it('ends with the window before an upcoming event', () => {
    expect(getUpDownCandleRange(event, false, 3)).toEqual({
      startAt: 0,
      endAt: 900_000,
      domain: { from: 0, to: 600, step: 300 },
    })
  })

  it('uses one candle per window of an event shorter than five minutes', () => {
    expect(getUpDownCandleRange({ start_at: 60_000, end_at: 120_000 }, true, 2)).toEqual({
      startAt: 0,
      endAt: 120_000,
      domain: { from: 0, to: 60, step: 60 },
    })
  })
})

describe('getUpDownCandlePages', () => {
  it('splits the range into pages of candles, oldest first', () => {
    const range = getUpDownCandleRange({ start_at: 900_000, end_at: 1_800_000 }, true, 6)
    expect(getUpDownCandlePages(range, 3)).toEqual([
      { startAt: 0, endAt: 900_000 },
      { startAt: 900_000, endAt: 1_800_000 },
    ])
  })

  it('keeps a partial oldest page inside the range', () => {
    const range = getUpDownCandleRange({ start_at: 900_000, end_at: 1_200_000 }, true, 4)
    expect(getUpDownCandlePages(range, 3)).toEqual([
      { startAt: 0, endAt: 300_000 },
      { startAt: 300_000, endAt: 1_200_000 },
    ])
  })
})
