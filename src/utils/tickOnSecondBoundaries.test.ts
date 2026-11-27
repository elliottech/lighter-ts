import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { tickOnSecondBoundaries } from './tickOnSecondBoundaries'

describe('tickOnSecondBoundaries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks on each second boundary and stops at the end', () => {
    const tick = vi.fn()
    tickOnSecondBoundaries(3_500, tick)
    vi.advanceTimersByTime(10_000)
    expect(tick).toHaveBeenCalledTimes(4)
  })

  it('stops when cleaned up from inside the tick', () => {
    const tick = vi.fn(() => cleanup())
    const cleanup = tickOnSecondBoundaries(10_000, tick)
    vi.advanceTimersByTime(5_000)
    expect(tick).toHaveBeenCalledTimes(1)
  })
})
