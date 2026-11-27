import { describe, expect, it } from 'vitest'

import { getCalendarCandleBucketTimeMs } from './getCalendarCandleBucketTimeMs'

describe('UTC calendar candle buckets (run in UTC and non-UTC timezones)', () => {
  it.each([
    ['1M', '2025-05-01T00:00:00Z', '2025-05-01T00:00:00Z'],
    ['1M', '2024-02-29T23:59:59Z', '2024-02-01T00:00:00Z'],
    ['1M', '2025-12-31T23:59:59Z', '2025-12-01T00:00:00Z'],
    ['1W', '2025-05-05T00:00:00Z', '2025-05-05T00:00:00Z'],
    ['1W', '2025-05-04T23:59:59Z', '2025-04-28T00:00:00Z'],
    ['1W', '2025-01-01T00:00:00Z', '2024-12-30T00:00:00Z'],
    ['1W', '2025-03-09T07:00:00Z', '2025-03-03T00:00:00Z'],
    ['1W', '2025-11-02T06:00:00Z', '2025-10-27T00:00:00Z'],
    ['3D', '2024-02-29T00:00:00Z', '2024-02-27T00:00:00Z'],
    ['3D', '2025-03-09T07:00:00Z', '2025-03-08T00:00:00Z'],
    ['3D', '2025-12-31T23:59:59Z', '2025-12-30T00:00:00Z'],
    ['3D', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  ] as const)('%s: %s → %s', (resolution, input, expected) => {
    expect(getCalendarCandleBucketTimeMs(Date.parse(input), resolution)).toBe(Date.parse(expected))
  })
})
