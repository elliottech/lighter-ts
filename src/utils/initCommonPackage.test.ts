import { afterEach, describe, expect, it, vi } from 'vitest'

import { fallbackData } from '../fallbacks'
import localFallbacks from '../fallbacks/local'
import mainnetFallbacks from '../fallbacks/mainnet'
import type { Env } from '../lib/env'
import { useLighterStore } from '../store/useLighterStore'
import { initCommonPackage } from './initCommonPackage'

const initialState = useLighterStore.getState()

const isSettled = async (promise: Promise<void>) => {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  return settled
}

const init = (
  env: Env,
  fallbacks: Parameters<typeof initCommonPackage>[0]['fallbacks'] = mainnetFallbacks,
) =>
  initCommonPackage({
    env,
    sha256: { digest: vi.fn() },
    websocketConfigParam: {},
    fallbacks,
  } as unknown as Parameters<typeof initCommonPackage>[0])

describe('initCommonPackage', () => {
  afterEach(() => {
    fallbackData.current = null
    fallbackData.tokens = null
    fallbackData.ready = Promise.resolve()
    useLighterStore.setState(initialState, true)
  })

  it('applies the fallback of the same env synchronously', async () => {
    init('mainnet')

    expect(fallbackData.current).toBe(mainnetFallbacks)
    expect(await isSettled(fallbackData.ready)).toBe(true)
    expect(Object.keys(useLighterStore.getState().perpsOrderBookMetas).length).toBeGreaterThan(0)
    expect(Object.keys(useLighterStore.getState().assetMetas).length).toBeGreaterThan(0)
  })

  it('ignores a fallback built for another env', () => {
    init('local')

    expect(fallbackData.current).toBeNull()
    expect(fallbackData.tokens).toBeNull()
    expect(useLighterStore.getState().tokens).toBeNull()
    expect(useLighterStore.getState().perpsOrderBookMetas).toEqual({})
    expect(useLighterStore.getState().assetMetas).toEqual({})
  })

  it('seeds the tokens of a tokens-only fallback and still waits for the API metas', async () => {
    init('local', localFallbacks)

    expect(fallbackData.current).toBeNull()
    expect(fallbackData.tokens).toBe(localFallbacks.tokens)
    expect(useLighterStore.getState().tokens?.length).toBeGreaterThan(0)
    expect(useLighterStore.getState().perpsOrderBookMetas).toEqual({})
    expect(await isSettled(fallbackData.ready)).toBe(false)
  })

  it('makes the websocket wait for both API metas without a matching fallback', async () => {
    init('local')
    expect(await isSettled(fallbackData.ready)).toBe(false)

    useLighterStore.setState({ orderBookMetasLoaded: true })
    expect(await isSettled(fallbackData.ready)).toBe(false)

    useLighterStore.setState({ assetMetasLoaded: true })
    expect(await isSettled(fallbackData.ready)).toBe(true)
  })
})
