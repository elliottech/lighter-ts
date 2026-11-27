import { OrderPriceGuardError } from '../engine/errors'
import { assertOrderPriceNearIndex } from '../engine/planner'
import { WorkerMarketData } from './WorkerMarketData'
import { useWsSubStore } from '../..'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeClock } from '../engine/testUtils'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import {
  WEBSOCKET_JANITOR_INTERVAL_MS,
  WorkerWebsocket,
  makeIsWorkerPriceFeedLive,
} from './WorkerWebsocket'

const getOrCreateAuthToken = vi.hoisted(() => vi.fn())
const resetAuthToken = vi.hoisted(() => vi.fn())

vi.mock('../../transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../transactions')>()),
  getOrCreateAuthToken,
  resetAuthToken,
}))
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
}))

const config: StrategyWorkerConfig = {
  customServer: null,
  encoding: 'msgpack',
  env: 'local',
  restApiBase: 'https://example.test',
  wsApiBase: 'wss://example.test/stream',
  wsPingIntervalMs: 2500,
  wsPongTimeoutMs: 12000,
}

const fakeWs = {} as NonNullable<ReturnType<typeof useWsSubStore.getState>['ws']>

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const fireUntil = (clock: FakeClock, at: number) => {
  for (let due = clock.nextDueAt(); due !== null && due <= at; ) {
    clock.fireNext()
    due = clock.nextDueAt()
  }
}

describe('WorkerWebsocket', () => {
  let clock: FakeClock
  let running: boolean
  let marketData: WorkerMarketData
  let websocket: WorkerWebsocket
  let onOpenFailed: ReturnType<typeof vi.fn<() => void>>
  const { actions } = useWsSubStore.getState()

  beforeEach(() => {
    vi.spyOn(actions, 'init').mockResolvedValue(undefined)
    vi.spyOn(actions, 'ping').mockImplementation(() => {})
    vi.spyOn(actions, 'forceClose').mockImplementation(() => useWsSubStore.setState({ ws: null }))
    useWsSubStore.setState({ ws: null, wsLoading: false, lastPingTime: null, lastPongTime: null })
    resetAuthToken.mockReset()
    onOpenFailed = vi.fn<() => void>()
    clock = new FakeClock()
    running = true
    marketData = new WorkerMarketData(clock)
    websocket = new WorkerWebsocket(
      marketData,
      clock,
      () => running,
      Promise.resolve(42),
      () => {},
      () => new Map(),
      config,
      onOpenFailed,
    )
    websocket.start()
  })

  afterEach(() => {
    websocket.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('janitor closes the socket once nothing runs and clears the prices', async () => {
    websocket.connect()
    await settle()
    useWsSubStore.setState({ ws: fakeWs })
    marketData.applyPrice({
      marketId: 1,
      indexPrice: null,
      markPrice: 10,
      midPrice: 10,
      bestAskPrice: null,
      bestBidPrice: null,
    })
    running = false
    clock.fireNext() // keep-alive tick stops itself
    expect(actions.forceClose).not.toHaveBeenCalled()
    clock.fireNext() // janitor tick
    expect(clock.now()).toBe(WEBSOCKET_JANITOR_INTERVAL_MS)
    expect(actions.forceClose).toHaveBeenCalledTimes(1)
    expect(marketData.hasPrice(1)).toBe(false)
    clock.fireNext() // janitor re-armed
    expect(clock.now()).toBe(2 * WEBSOCKET_JANITOR_INTERVAL_MS)
  })

  it('pings while connected and drops the socket on a missed pong', async () => {
    websocket.connect()
    await settle()
    expect(actions.init).toHaveBeenCalledTimes(1)
    useWsSubStore.setState({ ws: fakeWs, lastPingTime: 1, lastPongTime: 1 })
    fireUntil(clock, config.wsPingIntervalMs)
    expect(actions.ping).toHaveBeenCalledTimes(1)

    useWsSubStore.setState({
      lastPingTime: config.wsPongTimeoutMs + 2,
      lastPongTime: 1,
    })
    fireUntil(clock, 2 * config.wsPingIntervalMs)
    expect(actions.forceClose).toHaveBeenCalledTimes(1)
    expect(actions.ping).toHaveBeenCalledTimes(1)
  })

  it('drops the auth token, reports the failed open and retries', async () => {
    websocket.connect()
    await settle()
    expect(actions.init).toHaveBeenCalledTimes(1)
    useWsSubStore.setState({ wsLoading: true })
    useWsSubStore.setState({ wsLoading: false })
    expect(resetAuthToken).toHaveBeenCalledTimes(1)
    expect(onOpenFailed).toHaveBeenCalledTimes(1)

    fireUntil(clock, config.wsPingIntervalMs)
    await settle()
    expect(actions.init).toHaveBeenCalledTimes(2)
  })

  it('does not report a socket that opened', () => {
    useWsSubStore.setState({ wsLoading: true })
    useWsSubStore.setState({ ws: fakeWs, wsLoading: false })
    useWsSubStore.setState({ ws: null })
    expect(resetAuthToken).not.toHaveBeenCalled()
    expect(onOpenFailed).not.toHaveBeenCalled()
  })

  it('reconnects after an unexpected close while strategies run', async () => {
    websocket.connect()
    await settle()
    useWsSubStore.setState({ ws: fakeWs })
    fireUntil(clock, config.wsPingIntervalMs)
    expect(actions.init).toHaveBeenCalledTimes(1)
    marketData.applyPrice({
      marketId: 1,
      indexPrice: null,
      markPrice: 10,
      midPrice: 10,
      bestAskPrice: null,
      bestBidPrice: null,
    })
    useWsSubStore.setState({ ws: null })
    fireUntil(clock, 2 * config.wsPingIntervalMs)
    await settle()
    expect(actions.init).toHaveBeenCalledTimes(2)
    expect(marketData.hasPrice(1)).toBe(true)
  })

  it('inits with the encoding and custom server from the config', async () => {
    const configured = new WorkerWebsocket(
      marketData,
      clock,
      () => running,
      Promise.resolve(42),
      () => {},
      () => new Map(),
      { ...config, customServer: 'staging-2', encoding: 'json' },
    )
    configured.connect()
    await settle()
    configured.stop()
    expect(actions.init).toHaveBeenCalledWith(
      'wss://example.test/stream',
      expect.any(Function),
      expect.any(Function),
      'json',
      'staging-2',
      expect.any(Function),
    )
  })

  it('inits with msgpack and no custom server from the default config', async () => {
    websocket.connect()
    await settle()
    expect(actions.init).toHaveBeenCalledWith(
      'wss://example.test/stream',
      expect.any(Function),
      expect.any(Function),
      'msgpack',
      null,
      expect.any(Function),
    )
  })

  it('opens the socket only once the worker auth step has settled', async () => {
    let authenticated: () => void = () => {}
    const pending = new WorkerWebsocket(
      marketData,
      clock,
      () => running,
      new Promise<number>((resolve) => {
        authenticated = () => resolve(42)
      }),
      () => {},
      () => new Map(),
      config,
    )
    pending.connect()
    await settle()
    expect(actions.init).not.toHaveBeenCalled()
    authenticated()
    await settle()
    expect(actions.init).toHaveBeenCalledTimes(1)
    pending.stop()
  })

  it('does not open the socket when stopped before auth finishes', async () => {
    let authenticated: () => void = () => {}
    const pending = new WorkerWebsocket(
      marketData,
      clock,
      () => running,
      new Promise<number>((resolve) => {
        authenticated = () => resolve(42)
      }),
      () => {},
      () => new Map(),
      config,
    )
    pending.start()
    pending.connect()
    pending.stop()
    authenticated()
    await settle()
    expect(actions.init).not.toHaveBeenCalled()
  })

  it('does not open the socket when the janitor closed it before auth finishes', async () => {
    let authenticated: () => void = () => {}
    const pending = new WorkerWebsocket(
      marketData,
      clock,
      () => running,
      new Promise<number>((resolve) => {
        authenticated = () => resolve(42)
      }),
      () => {},
      () => new Map(),
      config,
    )
    pending.start()
    pending.connect()
    running = false
    fireUntil(clock, clock.now() + WEBSOCKET_JANITOR_INTERVAL_MS)
    authenticated()
    await settle()
    expect(actions.init).not.toHaveBeenCalled()
    pending.stop()
  })

  it('authenticates the socket with the auth token of the authenticated account', async () => {
    getOrCreateAuthToken.mockResolvedValue({ token: 'token-42' })
    websocket.connect()
    await settle()
    const getAuthToken = vi.mocked(actions.init).mock.calls[0]?.[2]
    await expect(getAuthToken?.()).resolves.toEqual({ token: 'token-42' })
    expect(getOrCreateAuthToken).toHaveBeenCalledWith(42)
  })

  it('never opens the socket when initialisation failed', async () => {
    const failed = new WorkerWebsocket(
      marketData,
      clock,
      () => running,
      Promise.reject(new Error('wasm failed')),
      () => {},
      () => new Map(),
      config,
    )
    failed.connect()
    await settle()
    expect(actions.init).not.toHaveBeenCalled()
    failed.stop()
  })
})

describe('worker prices while the socket is down', () => {
  const ETH = {
    market_id: 0,
    size_decimals: 4,
    price_decimals: 2,
    min_base_amount: '0',
    min_quote_amount: '0',
    multiplier: '1',
    display_price_decimals: 2,
  }
  const price = {
    marketId: 0,
    indexPrice: 2_400,
    markPrice: 2_400,
    midPrice: 2_400,
    bestAskPrice: 2_401,
    bestBidPrice: 2_399,
  }
  let marketData: WorkerMarketData

  beforeEach(() => {
    marketData = new WorkerMarketData(new FakeClock(), makeIsWorkerPriceFeedLive(config))
    marketData.setMarket(ETH)
    useWsSubStore.setState({ ws: fakeWs, lastPingTime: 1, lastPongTime: 1 })
    marketData.applyPrice(price)
  })

  afterEach(() => {
    useWsSubStore.setState({ ws: null, lastPingTime: null, lastPongTime: null })
  })

  it('serves the streamed prices while the socket is live', () => {
    expect(marketData.getIndexPrice(0)).toBe(2_400)
    expect(marketData.getBestBidPrice(0)).toBe(2_399)
  })

  it('serves no price once the socket closed, so nothing is priced off the frozen index', () => {
    useWsSubStore.setState({ ws: null, lastPingTime: null, lastPongTime: null })

    expect(marketData.getIndexPrice(0)).toBeNull()
    expect(marketData.getMarkPrice(0)).toBeNull()
    expect(marketData.getBestAskPrice(0)).toBeNull()
    expect(marketData.hasPrice(0)).toBe(false)
    expect(() => assertOrderPriceNearIndex(marketData, 0, 264_000, 0)).toThrow(OrderPriceGuardError)
  })

  it('serves no price while the open socket has missed its pong', () => {
    useWsSubStore.setState({
      lastPingTime: config.wsPongTimeoutMs + 2,
      lastPongTime: 1,
    })

    expect(marketData.getIndexPrice(0)).toBeNull()
  })

  it('serves the cached prices again once the socket is back', () => {
    useWsSubStore.setState({ ws: null, lastPingTime: null, lastPongTime: null })
    useWsSubStore.setState({ ws: fakeWs, lastPingTime: 5, lastPongTime: 5 })

    expect(marketData.getIndexPrice(0)).toBe(2_400)
  })

  it('resolves a pending price wait once the socket is back, without a new price', async () => {
    const websocket = new WorkerWebsocket(
      marketData,
      new FakeClock(),
      () => true,
      new Promise<number>(() => {}),
      () => {},
      () => new Map(),
      config,
    )
    websocket.start()
    try {
      useWsSubStore.setState({
        ws: null,
        lastPingTime: null,
        lastPongTime: null,
      })
      let resolved = false
      void marketData.waitForPrice(0, new AbortController().signal).then(() => (resolved = true))
      useWsSubStore.setState({ ws: fakeWs, lastPingTime: 5, lastPongTime: 5 })
      await settle()

      expect(resolved).toBe(true)
    } finally {
      useWsSubStore.setState({ ws: null })
      websocket.stop()
    }
  })

  it('resolves a pending price wait once a late pong arrives, without a new price', async () => {
    const websocket = new WorkerWebsocket(
      marketData,
      new FakeClock(),
      () => true,
      new Promise<number>(() => {}),
      () => {},
      () => new Map(),
      config,
    )
    websocket.start()
    try {
      useWsSubStore.setState({
        lastPingTime: config.wsPongTimeoutMs + 2,
        lastPongTime: 1,
      })
      let resolved = false
      void marketData.waitForPrice(0, new AbortController().signal).then(() => (resolved = true))
      await settle()
      expect(resolved).toBe(false)

      useWsSubStore.setState({ lastPongTime: config.wsPongTimeoutMs + 3 })
      await settle()

      expect(resolved).toBe(true)
    } finally {
      useWsSubStore.setState({ ws: null })
      websocket.stop()
    }
  })
})
