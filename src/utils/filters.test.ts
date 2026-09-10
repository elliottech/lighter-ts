import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PNL_HOURLY_RETENTION_BUFFER_SECONDS,
  PNL_HOURLY_RETENTION_SECONDS,
  getCustomRangeResolution,
  getPnlCustomRangeStartTimestamp,
  getTimelineStartTimestamp,
} from './filters'

const originalTimezone = process.env.TZ

afterEach(() => {
  process.env.TZ = originalTimezone
  vi.useRealTimers()
})

describe('getTimelineStartTimestamp', () => {
  it('starts YTD at midnight UTC outside UTC timezones', () => {
    process.env.TZ = 'Pacific/Honolulu'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'))

    expect(getTimelineStartTimestamp('ytd')).toBe(Date.UTC(2026, 0, 1) / 1000)
  })
})

describe('getPnlCustomRangeStartTimestamp', () => {
  it('does not move the start past the end for a pre-launch range', () => {
    const endTimestamp = Date.UTC(2024, 11, 31) / 1000

    expect(getPnlCustomRangeStartTimestamp(Date.UTC(2024, 0, 1) / 1000, endTimestamp)).toBe(
      endTimestamp,
    )
  })

  it('preserves a post-launch custom start', () => {
    const startTimestamp = Date.UTC(2025, 1, 1) / 1000

    expect(getPnlCustomRangeStartTimestamp(startTimestamp, Date.UTC(2025, 2, 1) / 1000)).toBe(
      startTimestamp,
    )
  })
})

describe('custom PnL range resolution', () => {
  it('uses the effective range after clamping', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-20T00:00:00Z'))
    const endTimestamp = Date.UTC(2025, 0, 17) / 1000
    const startTimestamp = getPnlCustomRangeStartTimestamp(
      Date.UTC(2024, 0, 1) / 1000,
      endTimestamp,
    )

    expect(getCustomRangeResolution(startTimestamp, endTimestamp)).toBe('1h')
  })

  it('uses daily resolution for a short range outside hourly retention', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))

    expect(getCustomRangeResolution(Date.UTC(2025, 5, 1) / 1000, Date.UTC(2025, 5, 7) / 1000)).toBe(
      '1d',
    )
  })

  it('uses daily resolution for a recent range longer than seven days', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))

    expect(
      getCustomRangeResolution(Date.UTC(2026, 7, 29) / 1000, Date.UTC(2026, 8, 7) / 1000),
    ).toBe('1d')
  })

  it('switches to daily at the hourly retention boundary', () => {
    const startTimestamp = Date.UTC(2026, 7, 29) / 1000
    const endTimestamp = Date.UTC(2026, 8, 4) / 1000
    const expiryTimestamp =
      startTimestamp + PNL_HOURLY_RETENTION_SECONDS - PNL_HOURLY_RETENTION_BUFFER_SECONDS

    expect(getCustomRangeResolution(startTimestamp, endTimestamp, expiryTimestamp - 1)).toBe('1h')
    expect(getCustomRangeResolution(startTimestamp, endTimestamp, expiryTimestamp)).toBe('1d')
  })
})
