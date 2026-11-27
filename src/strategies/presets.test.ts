import { describe, expect, it } from 'vitest'

import {
  ADVANCED_TWAP_PRESET,
  MAX_FREQUENCY_SEC,
  MIN_FREQUENCY_SEC,
  MIN_RUNTIME_SEC,
  formatJitterPct,
} from './presets'

describe('formatJitterPct', () => {
  it('formats common values as ±N%', () => {
    expect(formatJitterPct(0)).toBe('±0%')
    expect(formatJitterPct(0.3)).toBe('±30%')
    expect(formatJitterPct(0.4)).toBe('±40%')
    expect(formatJitterPct(1)).toBe('±100%')
  })

  it('rounds the percentage', () => {
    expect(formatJitterPct(0.123)).toBe('±12%') // 12.3 → 12
    expect(formatJitterPct(0.126)).toBe('±13%') // 12.6 → 13
    expect(formatJitterPct(0.005)).toBe('±1%') // 0.5 → 1 (Math.round half-away)
  })
})

describe('preset invariants', () => {
  it('default frequency sits inside the configured min/max bounds', () => {
    expect(ADVANCED_TWAP_PRESET.defaultFrequencySec).toBeGreaterThanOrEqual(MIN_FREQUENCY_SEC)
    expect(ADVANCED_TWAP_PRESET.defaultFrequencySec).toBeLessThanOrEqual(MAX_FREQUENCY_SEC)
  })

  it('jitter fractions are within [0, 1]', () => {
    expect(ADVANCED_TWAP_PRESET.sizeJitter).toBeGreaterThanOrEqual(0)
    expect(ADVANCED_TWAP_PRESET.sizeJitter).toBeLessThanOrEqual(1)
    expect(ADVANCED_TWAP_PRESET.intervalJitter).toBeGreaterThanOrEqual(0)
    expect(ADVANCED_TWAP_PRESET.intervalJitter).toBeLessThanOrEqual(1)
  })

  it('min runtime is shorter than max frequency (so the basic bounds make sense)', () => {
    expect(MIN_RUNTIME_SEC).toBeGreaterThan(0)
    expect(MIN_FREQUENCY_SEC).toBeLessThanOrEqual(MIN_RUNTIME_SEC)
    expect(MAX_FREQUENCY_SEC).toBeGreaterThan(MIN_FREQUENCY_SEC)
  })
})
