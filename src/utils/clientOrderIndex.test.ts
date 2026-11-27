import { beforeEach, describe, expect, it, vi } from 'vitest'

import { persistence } from '../lib/persistence'
import { StrategyOrderKind } from '../types/StrategyOrderKind'
import {
  generateTimestampClientOrderIndex,
  resetClientOrderIndexForTesting,
} from './clientOrderIndex'

const NOW_MS = 1_700_000_000_123
const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  persistence.getItem = (key) => storage.get(key) ?? null
  persistence.setItem = (key, value) => {
    storage.set(key, value)
  }
  resetClientOrderIndexForTesting()
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)
  return () => vi.restoreAllMocks()
})

describe('generateTimestampClientOrderIndex', () => {
  it('is the Unix ms for a plain order', async () => {
    expect(await generateTimestampClientOrderIndex()).toBe(NOW_MS)
  })

  it('puts the strategy kind above the 45 timestamp bits', async () => {
    const id = await generateTimestampClientOrderIndex(StrategyOrderKind.Rfq)
    expect(id).toBe(StrategyOrderKind.Rfq * 2 ** 45 + NOW_MS)
    expect(id).toBeLessThan(2 ** 48)
  })

  it('moves to the next ms when the current one is taken', async () => {
    const ids = await Promise.all(
      Array.from({ length: 50 }, () => generateTimestampClientOrderIndex()),
    )
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => NOW_MS + i))
  })

  it('continues after the last persisted ms across a restart', async () => {
    await generateTimestampClientOrderIndex()
    resetClientOrderIndexForTesting()
    expect(await generateTimestampClientOrderIndex()).toBe(NOW_MS + 1)
  })

  it('uses the clock again once it passes the last issued ms', async () => {
    await generateTimestampClientOrderIndex()
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 10)
    expect(await generateTimestampClientOrderIndex()).toBe(NOW_MS + 10)
  })
})
