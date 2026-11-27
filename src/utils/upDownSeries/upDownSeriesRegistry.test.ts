import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acquireUpDownSeries,
  peekUpDownSeries,
  refreshUpDownSeries,
  resetUpDownSeriesRegistry,
} from './upDownSeriesRegistry'

const mocks = vi.hoisted(() => ({
  created: [] as {
    complete: boolean
    dispose: ReturnType<typeof vi.fn>
    refresh: ReturnType<typeof vi.fn>
  }[],
}))

vi.mock('./createUpDownSeries', () => ({
  createUpDownSeries: () => {
    const series = { complete: false, dispose: vi.fn(), refresh: vi.fn() }
    mocks.created.push(series)
    return {
      getState: () => ({ isComplete: series.complete }),
      subscribe: () => () => {},
      refresh: series.refresh,
      dispose: series.dispose,
    }
  },
}))

const window = (startAt: number) => ({
  symbol: 'BTC',
  duration: 900,
  startAt,
  endAt: startAt + 900_000,
})

describe('upDownSeriesRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.created.length = 0
  })

  afterEach(() => {
    resetUpDownSeriesRegistry()
    vi.useRealTimers()
  })

  it('shares one series per window and keeps it through a quick re-acquire', () => {
    const first = acquireUpDownSeries(window(0))
    const second = acquireUpDownSeries(window(0))
    expect(first.series).toBe(second.series)
    expect(mocks.created).toHaveLength(1)

    first.release()
    second.release()
    second.release()
    vi.advanceTimersByTime(5_000)
    const again = acquireUpDownSeries(window(0))
    vi.advanceTimersByTime(20_000)

    expect(again.series).toBe(first.series)
    expect(mocks.created[0]!.dispose).not.toHaveBeenCalled()
  })

  it('disposes a running window shortly after its last release', () => {
    acquireUpDownSeries(window(0)).release()
    vi.advanceTimersByTime(10_000)

    expect(mocks.created[0]!.dispose).toHaveBeenCalled()
    expect(peekUpDownSeries(window(0))).toBeUndefined()
  })

  it('keeps a window that completed, even during the release delay', () => {
    acquireUpDownSeries(window(0)).release()
    mocks.created[0]!.complete = true
    vi.advanceTimersByTime(10_000)

    expect(mocks.created[0]!.dispose).not.toHaveBeenCalled()
    expect(peekUpDownSeries(window(0))).toBeDefined()
  })

  it('evicts the oldest completed windows past the cache size', () => {
    for (let index = 0; index < 33; index++) {
      const handle = acquireUpDownSeries(window(index * 900_000))
      mocks.created[index]!.complete = true
      vi.advanceTimersByTime(1)
      handle.release()
    }

    expect(mocks.created[0]!.dispose).toHaveBeenCalled()
    expect(mocks.created[1]!.dispose).not.toHaveBeenCalled()
  })

  it('refreshes mounted windows only', () => {
    const mounted = acquireUpDownSeries(window(0))
    acquireUpDownSeries(window(900_000)).release()
    refreshUpDownSeries()

    expect(mocks.created[0]!.refresh).toHaveBeenCalled()
    expect(mocks.created[1]!.refresh).not.toHaveBeenCalled()
    mounted.release()
  })
})
