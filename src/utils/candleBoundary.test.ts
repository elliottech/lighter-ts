import { describe, expect, it } from 'vitest'
import { assertCompleteCandleBoundary, assertCompleteLeadingCandleBucket } from './candlesticks'

describe('complete source boundaries', () => {
  it.each([
    { times: [0, 2] },
    { times: [0, 0.5, 2] },
    { times: [0, 1] },
    { times: [] },
    { times: [2, 1, 0] },
  ])('rejects invalid boundary $times', ({ times }) => {
    expect(() =>
      assertCompleteCandleBoundary(
        times.map((time) => ({ time: time * 60000 })),
        0,
        120000,
        60000,
      ),
    ).toThrow('Incomplete candle history boundary')
  })
  it('accepts complete and genuinely late-starting histories', () => {
    for (const times of [[0, 1, 2], [1, 2], [2]])
      expect(() =>
        assertCompleteCandleBoundary(
          times.map((time) => ({ time: time * 60000 })),
          0,
          120000,
          60000,
        ),
      ).not.toThrow()
  })
})

it.each([
  { resolution: '1M', start: Date.UTC(2024, 1, 1), days: 29 },
  { resolution: '1M', start: Date.UTC(2025, 1, 1), days: 28 },
  { resolution: '3D', start: Date.UTC(2025, 11, 30), days: 2 },
])('validates the calendar end for $resolution/$days days', ({ resolution, start, days }) => {
  const day = 86400000
  const bars = Array.from({ length: days + 1 }, (_, index) => ({ time: start + index * day }))
  expect(() => assertCompleteLeadingCandleBucket(bars, resolution, day)).not.toThrow()
  expect(() =>
    assertCompleteLeadingCandleBucket(
      bars.filter((_, index) => index !== days - 1),
      resolution,
      day,
    ),
  ).toThrow('Incomplete candle history boundary')
})

it('allows an explicit request cutoff inside a historical bucket', () => {
  const start = Date.UTC(2025, 4, 1)
  const bars = [{ time: start }, { time: start + 60000 }]
  expect(() => assertCompleteLeadingCandleBucket(bars, '3', 60000, start + 60000)).not.toThrow()
})
