import type {
  Clock,
  EngineEventListener,
  MarketDataSource,
  MarketMeta,
  StrategyEngine,
} from '../engine/types'
import type { EngineDeps } from '../engine/AdvancedTwapEngine'
import type { CancelOrderParams, CreateOrderParams, Order } from '../..'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { wsOrder } from '../engine/testUtils'

const ACCOUNT = 1
const MARKET_ID = 1

type Listener = (value: unknown) => void

const venue = vi.hoisted(() => ({
  state: { accounts: {} },
  subscriptions: new Set<{ selector: (state: unknown) => unknown; listener: Listener }>(),
  orders: new Map<number, Order>(),
  cancelsRateLimitedUntil: 0,
  snapshotsFailUntil: 0,
  unseenByWs: new Set<number>(),
  submitGate: null as Promise<void> | null,
  workingOrders: new Map<string, Order>(),
  unconfirmedOrders: new Set<number>(),
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
  nextClientOrderIndex: 100,
}))

vi.mock('../../transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../transactions')>()),
  createOrder: venue.createOrder,
  cancelOrder: venue.cancelOrder,
}))
vi.mock('../..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../..')>()),
  transactionConfig: {
    generateClientOrderIndex: () => Promise.resolve(venue.nextClientOrderIndex++),
  },
  useLighterStore: {
    getState: () => venue.state,
    subscribe: (
      selector: (state: unknown) => unknown,
      listener: Listener,
      options?: { fireImmediately?: boolean },
    ) => {
      const subscription = { selector, listener }
      venue.subscriptions.add(subscription)
      if (options?.fireImmediately) listener(selector(venue.state))
      return () => venue.subscriptions.delete(subscription)
    },
  },
}))
vi.mock('../orderSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderSnapshot')>()),
  fetchOrderSnapshot: ({ clientOrderIndex }: { clientOrderIndex: number }) =>
    Date.now() < venue.snapshotsFailUntil
      ? Promise.reject(new Error('Too Many Requests'))
      : Promise.resolve(venue.orders.get(clientOrderIndex)),
}))
vi.mock('../store/strategyStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/strategyStore')>()),
  useStrategyStore: {
    getState: () => ({
      addWorkingOrder: (_id: string, order: Order) =>
        venue.workingOrders.set(order.order_id, order),
      addUnconfirmedOrder: (_id: string, clientOrderIndex: number) =>
        venue.unconfirmedOrders.add(clientOrderIndex),
      removeUnconfirmedOrder: (_id: string, clientOrderIndex: number) =>
        venue.unconfirmedOrders.delete(clientOrderIndex),
    }),
  },
}))
vi.mock('../store/strategyStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/strategyStorage')>()),
  flushLatestStrategyStoreWrite: () => Promise.resolve(true),
  flushStrategyStoreWrites: () => Promise.resolve(),
}))
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
}))
vi.mock('./creditOrderTradeVolumesV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./creditOrderTradeVolumesV2')>()),
  creditOrderTradeVolumesV2: vi.fn(),
}))
vi.mock('./workerAccountFees', () => ({
  getStrategyIntegratorFees: () => undefined,
}))

const { ApiError, isOrderActive } = await import('../..')
const { AdvancedTwapEngine } = await import('../engine/AdvancedTwapEngine')
const { IcebergEngine } = await import('../engine/IcebergEngine')
const { LimitChaseEngine } = await import('../engine/LimitChaseEngine')
const { makeOrderClient } = await import('./makeOrderClient')
const { configureWorkerIdle, scheduleWorkerIdleCheck } = await import('./workerIdle')

const MARKET: MarketMeta = {
  market_id: MARKET_ID,
  size_decimals: 5,
  price_decimals: 2,
  min_base_amount: '0',
  min_quote_amount: '0',
  multiplier: '1',
  display_price_decimals: 2,
}

const marketData: MarketDataSource = {
  getMarket: (marketId) => (marketId === MARKET_ID ? MARKET : undefined),
  getIndexPrice: () => 50_000,
  getMarkPrice: () => 50_000,
  getMidPrice: () => 50_000,
  getBestBidPrice: () => 49_990,
  getBestAskPrice: () => 50_010,
}

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
}

const publish = () => {
  const all = [...venue.orders.values()].filter(
    (order) => !venue.unseenByWs.has(order.client_order_index),
  )
  venue.state = {
    accounts: {
      [ACCOUNT]: {
        activeOrders: { [MARKET_ID]: all.filter(isOrderActive) },
        inactiveOrders: { [MARKET_ID]: all.filter((order) => !isOrderActive(order)) },
      },
    },
  }
  for (const { selector, listener } of venue.subscriptions) listener(selector(venue.state))
}

const putOrder = (order: Order) => {
  venue.orders.set(order.client_order_index, order)
  publish()
}

const placeOnVenue = (request: CreateOrderParams & { clientOrderIndex: number }) => {
  const baseAmount = request.baseAmount / 10 ** MARKET.size_decimals
  const isMarket = request.orderType === 1
  const [order] = wsOrder({
    order_id: `order-${request.clientOrderIndex}`,
    client_order_index: request.clientOrderIndex,
    market_index: MARKET_ID,
    initial_base_amount: baseAmount,
    remaining_base_amount: isMarket ? 0 : baseAmount,
    filled_base_amount: isMarket ? baseAmount : 0,
    filled_quote_amount: isMarket ? baseAmount * 50_000 : 0,
    price: request.price / 10 ** MARKET.price_decimals,
    status: isMarket ? 'filled' : 'open',
    type: isMarket ? 'market' : 'limit',
  })
  putOrder(order)
}

const liveOrders = () => [...venue.orders.values()].filter(isOrderActive)

const ENGINES: {
  name: string
  create: (deps: EngineDeps, listener: EngineEventListener) => StrategyEngine
}[] = [
  {
    name: 'TWAP',
    create: (deps, listener) =>
      new AdvancedTwapEngine(
        {
          accountIndex: ACCOUNT,
          marketId: MARKET_ID,
          isAsk: 0,
          totalSize: 0.001,
          sliceCount: 10,
          baseIntervalMs: 60_000,
          intervalJitter: 0,
          sizeJitter: 0,
          reduceOnly: false,
          maxSlippagePct: 1,
          executionStyle: 'passive',
        },
        deps,
        listener,
      ),
  },
  {
    name: 'limit chase',
    create: (deps, listener) =>
      new LimitChaseEngine(
        {
          accountIndex: ACCOUNT,
          marketId: MARKET_ID,
          isAsk: 0,
          totalSize: 0.001,
          reduceOnly: false,
          maxDistancePercent: 1,
          restingChunkBaseAmount: 0.001,
          repriceIntervalMs: 60_000,
        },
        deps,
        listener,
      ),
  },
  {
    name: 'iceberg',
    create: (deps, listener) =>
      new IcebergEngine(
        {
          accountIndex: ACCOUNT,
          marketId: MARKET_ID,
          isAsk: 0,
          totalSize: 0.001,
          reduceOnly: false,
          postOnly: false,
          restingChunkBaseAmount: 0.0005,
          repriceIntervalMs: 60_000,
          limitPrice: 49_990,
          maxRestingOrders: 1,
        },
        deps,
        listener,
      ),
  },
]

describe.each(ENGINES)(
  'a $name stopped while the exchange rate-limits its cancels',
  ({ create }) => {
    const id = 'strategy-1'
    let engines: Map<string, StrategyEngine>
    let idleAt: number | null

    const startEngine = () => {
      const engine = create(
        {
          marketData,
          orderClient: makeOrderClient(id, () => engines, marketData),
          clock,
          createdAt: Date.now(),
        },
        (event) => {
          if (event.type === 'updateWorkingOrder')
            venue.workingOrders.set(event.order.order_id, event.order)
          if (event.type === 'removeWorkingOrder') venue.workingOrders.delete(event.order.order_id)
          if (event.type === 'status' && event.status !== 'running') {
            engines.delete(id)
            scheduleWorkerIdleCheck()
          }
        },
      )
      engines.set(id, engine)
      engine.start()
      return engine
    }

    beforeEach(() => {
      vi.useFakeTimers()
      venue.orders.clear()
      venue.subscriptions.clear()
      venue.cancelsRateLimitedUntil = 0
      venue.snapshotsFailUntil = 0
      venue.unseenByWs.clear()
      venue.submitGate = null
      venue.workingOrders.clear()
      venue.unconfirmedOrders.clear()
      venue.createOrder.mockReset()
      venue.createOrder.mockImplementation(
        async (request: CreateOrderParams & { clientOrderIndex: number }) => {
          await venue.submitGate
          placeOnVenue(request)
          return {}
        },
      )
      venue.cancelOrder.mockReset()
      venue.cancelOrder.mockImplementation((request: CancelOrderParams) => {
        if (Date.now() < venue.cancelsRateLimitedUntil) {
          return Promise.reject(new ApiError('Too Many Requests', 23000))
        }
        const order = [...venue.orders.values()].find((o) => o.order_id === request.orderId)
        if (!order || !isOrderActive(order)) {
          return Promise.reject(new ApiError('invalid order index', 21600))
        }
        putOrder({ ...order, status: 'canceled' })
        return Promise.resolve({})
      })
      publish()
      engines = new Map()
      idleAt = null
      configureWorkerIdle({
        isBusy: () => engines.size > 0,
        onIdle: () => {
          idleAt = Date.now()
        },
      })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('takes its resting order off the book once the rate limit clears', async () => {
      const engine = startEngine()
      await vi.advanceTimersByTimeAsync(0)
      expect(liveOrders()).toHaveLength(1)

      venue.cancelsRateLimitedUntil = Date.now() + 90_000
      engine.stop('Stopped by user')
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      expect(liveOrders()).toHaveLength(0)
      expect(venue.createOrder).toHaveBeenCalledTimes(1)
    })

    it('keeps the worker alive until its order is off the book', async () => {
      const engine = startEngine()
      await vi.advanceTimersByTimeAsync(0)

      venue.cancelsRateLimitedUntil = Date.now() + 90_000
      engine.stop('Stopped by user')
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      const canceledAt = venue.cancelsRateLimitedUntil
      expect(idleAt).not.toBeNull()
      expect(idleAt!).toBeGreaterThanOrEqual(canceledAt)
    })

    it('takes an order that lands after the stop off the book', async () => {
      let releaseSubmit = () => {}
      venue.submitGate = new Promise((resolve) => {
        releaseSubmit = resolve
      })
      const engine = startEngine()
      await vi.advanceTimersByTimeAsync(0)
      expect(liveOrders()).toHaveLength(0)

      venue.cancelsRateLimitedUntil = Date.now() + 90_000
      engine.stop('Stopped by user')
      releaseSubmit()
      await vi.advanceTimersByTimeAsync(5 * 60_000)

      expect(liveOrders()).toHaveLength(0)
      expect(venue.createOrder).toHaveBeenCalledTimes(1)
    })

    it('keeps its order on record when the rate limit outlasts the retries', async () => {
      const engine = startEngine()
      await vi.advanceTimersByTimeAsync(0)
      const [order] = liveOrders()

      venue.cancelsRateLimitedUntil = Date.now() + 20 * 60_000
      engine.stop('Stopped by user')
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(liveOrders()).toHaveLength(1)
      expect(venue.workingOrders.has(order!.order_id)).toBe(true)
    })

    it('keeps an order it never saw on record', async () => {
      venue.createOrder.mockImplementation(
        (request: CreateOrderParams & { clientOrderIndex: number }) => {
          venue.unseenByWs.add(request.clientOrderIndex)
          placeOnVenue(request)
          return Promise.reject(new Error('Failed to fetch'))
        },
      )
      venue.snapshotsFailUntil = Date.now() + 12 * 60_000
      const engine = startEngine()
      await vi.advanceTimersByTimeAsync(0)

      engine.stop('Stopped by user')
      await vi.advanceTimersByTimeAsync(15 * 60_000)

      const [order] = [...venue.orders.values()].filter(isOrderActive)
      expect(order).toBeDefined()
      expect(venue.unconfirmedOrders.has(order!.client_order_index)).toBe(true)
    })

    it('places no new order after the stop', async () => {
      const engine = startEngine()
      await vi.advanceTimersByTimeAsync(0)

      engine.stop('Stopped by user')
      await vi.advanceTimersByTimeAsync(20 * 60_000)

      expect(venue.createOrder).toHaveBeenCalledTimes(1)
      expect(liveOrders()).toHaveLength(0)
    })
  },
)
