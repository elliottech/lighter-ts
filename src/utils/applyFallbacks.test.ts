import { describe, expect, it } from 'vitest'

import robinhoodFallbacks from '../fallbacks/robinhood-mainnet'
import { useLighterStore } from '../store/useLighterStore'
import { applyFallbacks } from './applyFallbacks'

const initialState = useLighterStore.getState()

describe('applyFallbacks', () => {
  it('replaces the default config and seeds metas before the API responds', () => {
    const next = applyFallbacks(initialState, robinhoodFallbacks)

    expect(next.systemConfig).toBe(robinhoodFallbacks.systemConfig)
    expect(next.l1Info).toBe(robinhoodFallbacks.l1Info)
    expect(next.fallbackFeeTiers).toBe(robinhoodFallbacks.feeTiers)
    expect(Object.keys(next.perpsOrderBookMetas!).length).toBeGreaterThan(0)
    expect(Object.keys(next.assetMetas!).length).toBeGreaterThan(0)
  })

  it('keeps what the API already loaded', () => {
    const systemConfig = { ...initialState.systemConfig }
    const l1Info = { ...initialState.l1Info }
    const tokens = [{ symbol: 'ABC' }] as typeof initialState.tokens
    const next = applyFallbacks(
      {
        ...initialState,
        systemConfig,
        l1Info,
        tokens,
        orderBookMetasLoaded: true,
        assetMetasLoaded: true,
      },
      robinhoodFallbacks,
    )

    expect(next.systemConfig).toBe(systemConfig)
    expect(next.l1Info).toBe(l1Info)
    expect(next.tokens).toBe(tokens)
    expect(next).not.toHaveProperty('perpsOrderBookMetas')
    expect(next).not.toHaveProperty('assetMetas')
  })
})
