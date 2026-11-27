import type { ChaseLimitStrategyRecord, Clock, StrategyStatus } from '../engine/types'
import type { MainToWorker, WorkerAuthMessage } from './protocol'
import type { Order } from '../..'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { wsOrder } from '../engine/testUtils'

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout

const strategyWorkerConfig: StrategyWorkerConfig = {
  customServer: null,
  encoding: 'msgpack',
  env: 'staging',
  restApiBase: 'https://api.test',
  wsApiBase: 'wss://api.test/stream',
  wsPingIntervalMs: 2500,
  wsPongTimeoutMs: 12000,
}

const mocks = vi.hoisted(() => ({
  fetchOrderSnapshot:
    vi.fn<
      (params: { accountIndex: number; clientOrderIndex: number }) => Promise<Order | undefined>
    >(),
  cancelOrderUntilTerminalState:
    vi.fn<(params: { orderId: string; clientOrderIndex: number }) => Promise<Order>>(),
  creditFillDelta: vi.fn(),
  creditOrderTradeVolumesV2: vi.fn(),
  createEngine: vi.fn(),
  postMessage: vi.fn(),
}))

vi.mock('../store/strategyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/strategyStore')>()
  Object.assign(actual.useStrategyStore, {
    persist: { rehydrate: () => Promise.resolve(), hasHydrated: () => true },
  })
  return actual
})
vi.mock('../..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../..')>()),
  selectOrderById: () => undefined,
  useLighterStore: { getState: () => ({}) },
}))
vi.mock('../orderSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderSnapshot')>()),
  fetchOrderSnapshot: mocks.fetchOrderSnapshot,
}))
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
  configureWorkerExceptions: vi.fn(),
}))
vi.mock('./factories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./factories')>()),
  createEngine: mocks.createEngine,
}))
vi.mock('./WorkerMarketData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./WorkerMarketData')>()),
  WorkerMarketData: class {
    hasMarket = () => true
    hasPrice = () => true
    initializeMarketMetas = () => Promise.resolve()
    waitForPrice = () => Promise.resolve()
  },
}))
vi.mock('./workerAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerAuth')>()),
  assertWorkerAccount: () => {},
  authenticateWorker: () => Promise.resolve(5),
  isWorkerRegistered: () => true,
}))
vi.mock('./creditOrderTradeVolumesV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./creditOrderTradeVolumesV2')>()),
  creditClosingOrderFillDelta: vi.fn(),
  creditFillDelta: mocks.creditFillDelta,
  creditOrderTradeVolumesV2: mocks.creditOrderTradeVolumesV2,
}))
vi.mock('./makeEventListener', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./makeEventListener')>()),
  makeEventListener: () => () => {},
}))
vi.mock('./workerIdle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerIdle')>()),
  configureWorkerIdle: () => {},
  markWorkerBusy: () => {},
  scheduleWorkerIdleCheck: () => {},
  trackWorkerTask: <T>(task: Promise<T>) => task,
}))
vi.mock('../orderLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderLifecycle')>()),
  cancelOrderUntilTerminalState: mocks.cancelOrderUntilTerminalState,
}))
vi.mock('./makeOrderClient', () => ({ makeOrderClient: () => ({}) }))
vi.mock('./WorkerWebsocket', () => ({
  WorkerWebsocket: class {
    start() {}
    connect() {}
  },
  makeIsWorkerPriceFeedLive: () => () => true,
}))
vi.mock('./workerAccountFees', () => ({
  initWorkerAccountFees: () => Promise.resolve(),
  refreshStrategyUserTier: () => Promise.resolve(),
}))

const { useStrategyStore } = await import('../store/strategyStore')

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: realSetTimeout,
  clearTimeout: realClearTimeout,
}

let worker: InstanceType<typeof import('./StrategyWorker').StrategyWorker>

const startWorker = async () => {
  const { StrategyWorker } = await import('./StrategyWorker')
  worker = new StrategyWorker({
    clock,
    post: mocks.postMessage,
    strategyWorkerConfig,
    signersReady: Promise.resolve(),
  })
  return (msg: MainToWorker | WorkerAuthMessage) => {
    switch (msg.kind) {
      case 'authenticate':
        worker.authenticate(msg)
        break
      case 'start':
        void worker.start(msg)
        break
      case 'stop':
        worker.stop(msg)
        break
      case 'remove':
        worker.remove(msg)
        break
    }
  }
}

const SENT_AT = 1_700_000_000_000

const record = (): ChaseLimitStrategyRecord => ({
  id: 'chase-1',
  kind: 'chase-limit',
  config: {
    accountIndex: 5,
    marketId: 1,
    isAsk: 0,
    totalSize: 1,
    reduceOnly: false,
    maxDistancePercent: 0,
    restingChunkBaseAmount: 0.5,
    repriceIntervalMs: 1000,
  },
  progress: {
    status: 'running',
    totalBaseAmount: 1,
    filledBaseAmount: 0,
    filledQuoteAmount: 0,
    makerBaseAmount: 0,
    nextActionAt: null,
  },
  workingOrders: {},
  unconfirmedOrders: {
    21: { marketId: 1, orderType: 0, sentAt: SENT_AT },
  },
  createdAt: 0,
})

const [restingOrder] = wsOrder({
  order_id: 'o21',
  client_order_index: 21,
  market_index: 1,
  status: 'open',
  remaining_base_amount: 0.5,
  initial_base_amount: 0.5,
})
const [cancelledOrder] = wsOrder({
  ...restingOrder,
  status: 'canceled',
  remaining_base_amount: 0,
  filled_base_amount: 0.1,
  filled_quote_amount: 10,
})

const makeEngine = (initialStatus: 'running' | 'aborted' = 'running') => {
  let status: StrategyStatus = initialStatus
  return {
    setStatus: (next: StrategyStatus) => {
      status = next
    },
    start: vi.fn(),
    stop: vi.fn(() => {
      status = 'aborted'
    }),
    onFillUpdate: vi.fn(),
    adoptOrder: vi.fn(),
    on: () => () => {},
    getProgress: () => ({ ...record().progress, status }),
    getWorkingOrders: () => ({}),
  }
}

const startMessage = (workingOrders: Record<string, Order> = {}): MainToWorker => ({
  kind: 'start',
  id: 'chase-1',
  strategyKind: 'chase-limit',
  config: record().config,
  createdAt: 0,
  resume: {
    filledBaseAmount: 0,
    filledQuoteAmount: 0,
    makerBaseAmount: 0,
    workingOrders,
  },
})

const strategy = () => useStrategyStore.getState().strategies['chase-1']

let send: (msg: MainToWorker | WorkerAuthMessage) => void

describe('unconfirmed orders of a strategy that is stopped', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(SENT_AT + 60_000)
    mocks.fetchOrderSnapshot.mockReset().mockResolvedValue(undefined)
    mocks.cancelOrderUntilTerminalState
      .mockReset()
      .mockImplementation(({ orderId, clientOrderIndex }) =>
        Promise.resolve(
          orderId === cancelledOrder.order_id
            ? cancelledOrder
            : {
                ...cancelledOrder,
                order_id: orderId,
                client_order_index: clientOrderIndex,
                filled_base_amount: 0,
                filled_quote_amount: 0,
              },
        ),
      )
    mocks.creditFillDelta.mockReset()
    mocks.creditOrderTradeVolumesV2
      .mockReset()
      .mockImplementation((id: string, order: Order) =>
        useStrategyStore.getState().removeUnconfirmedOrder(id, order.client_order_index),
      )
    mocks.createEngine.mockReset()
    vi.resetModules()
    send = await startWorker()
    useStrategyStore.setState({ strategies: { 'chase-1': record() } })
    send({ kind: 'authenticate', signer: null, isPoolAccount: false })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const expectSettled = () => {
    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledWith({
      accountIndex: 5,
      marketId: 1,
      orderId: 'o21',
      clientOrderIndex: 21,
    })
    expect(mocks.creditFillDelta).toHaveBeenCalledWith('chase-1', {
      baseDelta: 0.1,
      quoteDelta: 10,
      isMaker: true,
    })
    expect(mocks.creditOrderTradeVolumesV2).toHaveBeenCalledWith('chase-1', cancelledOrder)
    expect(strategy()?.unconfirmedOrders).toBeUndefined()
    expect(strategy()?.progress.status).toBe('aborted')
  }

  it('while the resume waits for it: the order is cancelled and credited, not adopted', async () => {
    const engine = makeEngine()
    mocks.createEngine.mockReturnValue(engine)

    send(startMessage())
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.fetchOrderSnapshot).toHaveBeenCalledTimes(1)

    send({ kind: 'stop', id: 'chase-1' })
    expect(engine.stop).toHaveBeenCalled()
    useStrategyStore.getState().patchProgress('chase-1', { status: 'aborted', reason: 'Stopped' })
    mocks.fetchOrderSnapshot.mockResolvedValue(restingOrder)
    await vi.advanceTimersByTimeAsync(10_000)

    expectSettled()
    expect(engine.adoptOrder).not.toHaveBeenCalled()
    expect(engine.start).not.toHaveBeenCalled()
  })

  it('before its start settles: the order is waited for, then cancelled and credited', async () => {
    send(startMessage())
    send({ kind: 'stop', id: 'chase-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(strategy()?.progress.status).toBe('aborted')
    expect(mocks.fetchOrderSnapshot).toHaveBeenCalledTimes(1)
    expect(mocks.cancelOrderUntilTerminalState).not.toHaveBeenCalled()

    mocks.fetchOrderSnapshot.mockResolvedValue(restingOrder)
    await vi.advanceTimersByTimeAsync(10_000)

    expectSettled()
  })

  it('before its start settles: the working orders are cancelled without waiting for the in-flight one', async () => {
    const [working] = wsOrder({
      order_id: 'o1',
      client_order_index: 1,
      market_index: 1,
      status: 'open',
    })

    send(startMessage({ o1: working }))
    send({ kind: 'stop', id: 'chase-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledTimes(1)
    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledWith({
      accountIndex: 5,
      marketId: 1,
      orderId: 'o1',
      clientOrderIndex: 1,
    })
    expect(strategy()?.unconfirmedOrders).toEqual(record().unconfirmedOrders)

    mocks.fetchOrderSnapshot.mockResolvedValue(restingOrder)
    await vi.advanceTimersByTimeAsync(10_000)

    expectSettled()
  })

  it('when the engine aborts in its constructor: it and the working orders are cancelled', async () => {
    mocks.createEngine.mockImplementation(() => {
      // The constructor's abort reaches the record through its listener.
      useStrategyStore
        .getState()
        .patchProgress('chase-1', { status: 'aborted', reason: 'Too many' })
      return makeEngine('aborted')
    })
    const [working] = wsOrder({
      order_id: 'o1',
      client_order_index: 1,
      market_index: 1,
      status: 'open',
    })
    mocks.fetchOrderSnapshot.mockResolvedValue(restingOrder)

    send(startMessage({ o1: working }))
    await vi.advanceTimersByTimeAsync(0)

    expectSettled()
    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledWith({
      accountIndex: 5,
      marketId: 1,
      orderId: 'o1',
      clientOrderIndex: 1,
    })
  })

  it('when the cancel fails: the entry is left in place', async () => {
    mocks.fetchOrderSnapshot.mockResolvedValue(restingOrder)
    mocks.cancelOrderUntilTerminalState.mockRejectedValue(new Error('timeout'))

    send(startMessage())
    send({ kind: 'stop', id: 'chase-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledTimes(1)
    expect(mocks.creditFillDelta).not.toHaveBeenCalled()
    expect(strategy()?.unconfirmedOrders).toEqual(record().unconfirmedOrders)
  })

  it('when the lookup keeps failing: the entry is left in place', async () => {
    mocks.fetchOrderSnapshot.mockRejectedValue(new Error('network'))

    send(startMessage())
    send({ kind: 'stop', id: 'chase-1' })
    await vi.advanceTimersByTimeAsync(11 * 60_000)

    expect(mocks.cancelOrderUntilTerminalState).not.toHaveBeenCalled()
    expect(strategy()?.unconfirmedOrders).toEqual(record().unconfirmedOrders)
    expect(strategy()?.progress.status).toBe('aborted')
  })
})

describe('unconfirmed orders of a resumed strategy', () => {
  const [secondOrder] = wsOrder({
    order_id: 'o22',
    client_order_index: 22,
    market_index: 1,
    status: 'open',
    remaining_base_amount: 0.5,
    initial_base_amount: 0.5,
  })

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(SENT_AT + 60_000)
    mocks.fetchOrderSnapshot.mockReset()
    mocks.cancelOrderUntilTerminalState.mockReset().mockResolvedValue({
      ...cancelledOrder,
      ...secondOrder,
      status: 'canceled',
    })
    mocks.creditFillDelta.mockReset()
    mocks.creditOrderTradeVolumesV2.mockReset()
    mocks.createEngine.mockReset()
    vi.resetModules()
    send = await startWorker()
    useStrategyStore.setState({
      strategies: {
        'chase-1': {
          ...record(),
          unconfirmedOrders: {
            21: { marketId: 1, orderType: 0, sentAt: SENT_AT },
            22: { marketId: 1, orderType: 0, sentAt: SENT_AT },
          },
        },
      },
    })
    send({ kind: 'authenticate', signer: null, isPoolAccount: false })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('when an adopted order ends the engine: the remaining ones are cancelled, not adopted', async () => {
    const engine = makeEngine()
    engine.adoptOrder.mockImplementationOnce(() => engine.setStatus('completed'))
    mocks.createEngine.mockReturnValue(engine)
    mocks.fetchOrderSnapshot.mockImplementation(({ clientOrderIndex }) =>
      Promise.resolve(clientOrderIndex === 21 ? restingOrder : secondOrder),
    )

    send(startMessage())
    await vi.advanceTimersByTimeAsync(0)

    expect(engine.adoptOrder).toHaveBeenCalledTimes(1)
    expect(engine.adoptOrder).toHaveBeenCalledWith(restingOrder, true)
    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledTimes(1)
    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledWith({
      accountIndex: 5,
      marketId: 1,
      orderId: 'o22',
      clientOrderIndex: 22,
    })
    expect(engine.start).not.toHaveBeenCalled()
  })

  it('when a later lookup fails: the orders found are adopted before the engine stops', async () => {
    const engine = makeEngine()
    mocks.createEngine.mockReturnValue(engine)
    mocks.fetchOrderSnapshot.mockImplementation(({ clientOrderIndex }) =>
      clientOrderIndex === 21
        ? Promise.resolve(restingOrder)
        : Promise.reject(new Error('network')),
    )

    send(startMessage())
    await vi.advanceTimersByTimeAsync(11 * 60_000)

    expect(engine.adoptOrder).toHaveBeenCalledWith(restingOrder, true)
    expect(engine.stop).toHaveBeenCalledWith('Failed to resume order')
    expect(engine.start).not.toHaveBeenCalled()
    expect(Object.keys(strategy()?.unconfirmedOrders ?? {})).toContain('22')
  })
})

describe('a second start for the same strategy', () => {
  const freshStart = (): MainToWorker => ({
    kind: 'start',
    id: 'chase-1',
    strategyKind: 'chase-limit',
    config: record().config,
    createdAt: 0,
  })

  let engine: ReturnType<typeof makeEngine>

  beforeEach(async () => {
    engine = makeEngine()
    mocks.createEngine.mockReset().mockReturnValue(engine)
    vi.resetModules()
    send = await startWorker()
    useStrategyStore.setState({ strategies: {} })
    send({ kind: 'authenticate', signer: null, isPoolAccount: false })
  })

  it('is refused while the first one is still starting', async () => {
    send(freshStart())
    send(freshStart())

    await vi.waitFor(() => expect(mocks.createEngine).toHaveBeenCalledOnce())
    await new Promise((resolve) => realSetTimeout(resolve, 20))
    expect(mocks.createEngine).toHaveBeenCalledOnce()
  })

  it('is refused once the first one is running', async () => {
    send(freshStart())
    await vi.waitFor(() => expect(engine.start).toHaveBeenCalledOnce())

    send(freshStart())
    await new Promise((resolve) => realSetTimeout(resolve, 20))
    expect(mocks.createEngine).toHaveBeenCalledOnce()
  })
})

describe('a stop that arrives while the running records are still loading', () => {
  let engine: ReturnType<typeof makeEngine>

  beforeEach(async () => {
    engine = makeEngine()
    mocks.createEngine.mockReset().mockReturnValue(engine)
    mocks.cancelOrderUntilTerminalState.mockReset().mockResolvedValue(cancelledOrder)
    mocks.postMessage.mockReset()
    vi.resetModules()
    send = await startWorker()
    useStrategyStore.setState({
      strategies: {
        'chase-1': { ...record(), workingOrders: { o21: restingOrder }, unconfirmedOrders: {} },
      },
    })
    send({ kind: 'authenticate', signer: null, isPoolAccount: false })
  })

  it('stops the resume the load started instead of letting it run beside the cancelled orders', async () => {
    void worker.resumeRunningStrategies()
    send({ kind: 'stop', id: 'chase-1', reason: 'Stopped by user' })

    await vi.waitFor(() => expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalled())
    await new Promise((resolve) => realSetTimeout(resolve, 20))

    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(strategy()?.progress.status).toBe('aborted')
    expect(mocks.postMessage).toHaveBeenCalledWith({
      kind: 'event',
      id: 'chase-1',
      event: { type: 'status', status: 'aborted', reason: 'Stopped by user', record: strategy() },
    })
    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledTimes(1)
    expect(mocks.cancelOrderUntilTerminalState).toHaveBeenCalledWith({
      accountIndex: 5,
      marketId: 1,
      orderId: 'o21',
      clientOrderIndex: 21,
    })
  })
})
