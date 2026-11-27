import { AdvancedTwapEngine } from '../engine/AdvancedTwapEngine'
import { IcebergEngine } from '../engine/IcebergEngine'
import { LimitChaseEngine } from '../engine/LimitChaseEngine'
import type { MarketDataSource, MarketMeta, StrategyEngine } from '../engine/types'
import { ApiError, type Order } from '../..'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeClock, wsOrder } from '../engine/testUtils'

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  fetchOrderSnapshot: vi.fn(),
  listeners: [] as ((order: Order | undefined) => void)[],
  nextClientOrderIndex: 1,
}))

vi.mock('../../transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../transactions')>()),
  createOrder: mocks.createOrder,
}))
vi.mock('../..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../..')>()),
  transactionConfig: {
    generateClientOrderIndex: () => Promise.resolve(mocks.nextClientOrderIndex++),
  },
  useLighterStore: {
    getState: () => ({}),
    subscribe: (_selector: unknown, listener: (order: Order | undefined) => void) => {
      mocks.listeners.push(listener)
      return () => {}
    },
  },
}))
vi.mock('../orderSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderSnapshot')>()),
  fetchOrderSnapshot: mocks.fetchOrderSnapshot,
}))
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
}))
vi.mock('../store/strategyStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/strategyStore')>()),
  useStrategyStore: {
    getState: () => ({
      addWorkingOrder: vi.fn(),
      addUnconfirmedOrder: vi.fn(),
      removeUnconfirmedOrder: vi.fn(),
    }),
  },
}))
vi.mock('../store/strategyStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/strategyStorage')>()),
  flushLatestStrategyStoreWrite: () => Promise.resolve(true),
}))
vi.mock('./workerIdle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerIdle')>()),
  trackWorkerTask: <T>(task: Promise<T>) => task,
}))
vi.mock('./creditOrderTradeVolumesV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./creditOrderTradeVolumesV2')>()),
  creditOrderTradeVolumesV2: vi.fn(),
}))

vi.mock('./workerAccountFees', () => ({
  getStrategyIntegratorFees: () => undefined,
}))

const { makeOrderClient } = await import('./makeOrderClient')

const MARKET: MarketMeta = {
  market_id: 0,
  size_decimals: 2,
  price_decimals: 2,
  min_base_amount: '1',
  min_quote_amount: '10',
  multiplier: '1',
  display_price_decimals: 2,
}

const marketData: MarketDataSource = {
  getMarket: () => MARKET,
  getIndexPrice: () => 100,
  getMarkPrice: () => 100,
  getMidPrice: () => 100,
  getBestBidPrice: () => 100,
  getBestAskPrice: () => 100,
}

const STRATEGY_ID = 'strategy-1'
const TOTAL = 4
const CHUNK = 2

const landedOrder = (overrides: Partial<Order> = {}) =>
  wsOrder({
    order_id: 'landed-1',
    client_order_index: 1,
    status: 'open',
    price: 100,
    initial_base_amount: CHUNK,
    ...overrides,
  })[0]

type Build = (deps: {
  marketData: MarketDataSource
  orderClient: ReturnType<typeof makeOrderClient>
  clock: FakeClock
}) => StrategyEngine

const builds: [string, Build][] = [
  [
    'chase',
    (deps) =>
      new LimitChaseEngine(
        {
          accountIndex: 1,
          marketId: 0,
          isAsk: 0,
          totalSize: TOTAL,
          reduceOnly: false,
          maxDistancePercent: 0,
          restingChunkBaseAmount: CHUNK,
          repriceIntervalMs: 1_000,
        },
        deps,
        () => {},
      ),
  ],
  [
    'iceberg',
    (deps) =>
      new IcebergEngine(
        {
          accountIndex: 1,
          marketId: 0,
          isAsk: 0,
          totalSize: TOTAL,
          reduceOnly: false,
          postOnly: false,
          restingChunkBaseAmount: CHUNK,
          repriceIntervalMs: 1_000,
          limitPrice: 100,
          maxRestingOrders: 1,
        },
        deps,
        () => {},
      ),
  ],
]

const startEngine = (build: Build) => {
  const engines = new Map<string, StrategyEngine>()
  const clock = new FakeClock()
  const orderClient = makeOrderClient(STRATEGY_ID, () => engines, marketData)
  const engine = build({ marketData, orderClient, clock })
  engines.set(STRATEGY_ID, engine)
  engine.start()
  return { engine, clock }
}

const sentBaseAmount = () =>
  mocks.createOrder.mock.calls.reduce<number>(
    (sum, [request]) => sum + (request as { baseAmount: number }).baseAmount,
    0,
  ) /
  10 ** MARKET.size_decimals

const runEngineTimers = async (clock: FakeClock) => {
  for (let i = 0; i < 5; i++) {
    clock.fireNext()
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('a strategy submit whose outcome is unknown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.listeners.length = 0
    mocks.nextClientOrderIndex = 1
    mocks.createOrder.mockReset()
    mocks.fetchOrderSnapshot.mockReset()
    mocks.fetchOrderSnapshot.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe.each(builds)('%s', (_name, build) => {
    it.each([
      ['the tx executed', () => Promise.resolve({})],
      ['the tx timed out', () => Promise.reject(new Error('Tx Timeout'))],
    ])(
      'adopts the order that lands late when %s, instead of sending a second chunk',
      async (_case, createOrderOutcome) => {
        mocks.createOrder.mockImplementation(createOrderOutcome)
        const { engine, clock } = startEngine(build)

        await vi.advanceTimersByTimeAsync(30_000)
        await runEngineTimers(clock)

        expect(mocks.createOrder).toHaveBeenCalledTimes(1)

        mocks.listeners[0]?.(landedOrder())
        await vi.advanceTimersByTimeAsync(0)

        expect(Object.keys(engine.getWorkingOrders())).toEqual(['landed-1'])
        expect(sentBaseAmount()).toBeLessThanOrEqual(TOTAL)
      },
    )

    it('sends the chunk again once the unseen tx can no longer execute', async () => {
      mocks.createOrder
        .mockRejectedValueOnce(new Error('Tx Timeout'))
        .mockImplementation(() => new Promise(() => {}))
      const { clock } = startEngine(build)

      await vi.advanceTimersByTimeAsync(11 * 60_000)
      await runEngineTimers(clock)

      expect(mocks.createOrder).toHaveBeenCalledTimes(2)
    })

    it('aborts instead of resending when an executed order never shows up', async () => {
      mocks.createOrder.mockResolvedValue({})
      const { engine, clock } = startEngine(build)

      await vi.advanceTimersByTimeAsync(11 * 60_000)
      await runEngineTimers(clock)

      expect(mocks.createOrder).toHaveBeenCalledTimes(1)
      expect(engine.getProgress().status).toBe('aborted')
    })

    it('retries at once after a definitive exchange rejection', async () => {
      mocks.createOrder
        .mockRejectedValueOnce(new ApiError('too many pending txs', 23000))
        .mockImplementation(() => new Promise(() => {}))
      const { clock } = startEngine(build)

      await vi.advanceTimersByTimeAsync(0)
      await runEngineTimers(clock)

      expect(mocks.createOrder).toHaveBeenCalledTimes(2)
    })
  })

  it('TWAP adopts a late limit slice instead of writing it off and leaving it untracked', async () => {
    mocks.createOrder.mockRejectedValue(new Error('Tx Timeout'))
    const engines = new Map<string, StrategyEngine>()
    const clock = new FakeClock()
    const orderClient = makeOrderClient(STRATEGY_ID, () => engines, marketData)
    const engine = new AdvancedTwapEngine(
      {
        accountIndex: 1,
        marketId: 0,
        isAsk: 0,
        totalSize: 40,
        sliceCount: 2,
        baseIntervalMs: 60 * 60_000,
        intervalJitter: 0,
        sizeJitter: 0,
        reduceOnly: false,
        maxSlippagePct: 5,
        executionStyle: 'passive',
      },
      { marketData, orderClient, clock, createdAt: 0 },
      () => {},
    )
    engines.set(STRATEGY_ID, engine)
    engine.start()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(mocks.createOrder).toHaveBeenCalledTimes(1)
    expect(mocks.createOrder.mock.calls[0]![0]).toMatchObject({
      orderType: 0,
      baseAmount: 400,
    })

    mocks.listeners[0]?.(landedOrder({ initial_base_amount: 4 }))
    await vi.advanceTimersByTimeAsync(0)

    expect(Object.keys(engine.getWorkingOrders())).toEqual(['landed-1'])
    expect((engine.getProgress() as { failedBaseAmount: number }).failedBaseAmount).toBe(0)
  })
})
