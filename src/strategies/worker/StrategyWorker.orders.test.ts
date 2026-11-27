import type { ChaseLimitStrategyRecord, Clock } from '../engine/types'
import type { MainToWorker } from './protocol'
import type { Order, WsOrder } from '../..'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { expect, it, vi } from 'vitest'
import { StrategyWorker } from './StrategyWorker'
import { wsOrder } from '../engine/testUtils'

const mocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
  onOrder: (() => {}) as (order: WsOrder) => void,
}))

vi.mock('../store/strategyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/strategyStore')>()
  Object.assign(actual.useStrategyStore, {
    persist: { rehydrate: () => Promise.resolve(), hasHydrated: () => true },
  })
  return actual
})
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
  },
}))
vi.mock('./workerAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerAuth')>()),
  assertWorkerAccount: () => {},
  authenticateWorker: () => Promise.resolve(5),
  isWorkerRegistered: () => true,
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
vi.mock('./makeOrderClient', () => ({ makeOrderClient: () => ({}) }))
vi.mock('./WorkerWebsocket', () => ({
  WorkerWebsocket: class {
    constructor(...args: unknown[]) {
      mocks.onOrder = args[4] as (order: WsOrder) => void
    }
    start() {}
    connect() {}
  },
  makeIsWorkerPriceFeedLive: () => () => true,
}))
vi.mock('./workerAccountFees', () => ({
  initWorkerAccountFees: () => Promise.resolve(),
  refreshStrategyUserTier: () => Promise.resolve(),
}))

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
}

const strategyWorkerConfig: StrategyWorkerConfig = {
  customServer: null,
  encoding: 'msgpack',
  env: 'staging',
  restApiBase: 'https://api.test',
  wsApiBase: 'wss://api.test/stream',
  wsPingIntervalMs: 2500,
  wsPongTimeoutMs: 12000,
}

const config: ChaseLimitStrategyRecord['config'] = {
  accountIndex: 5,
  marketId: 1,
  isAsk: 0,
  totalSize: 1,
  reduceOnly: false,
  maxDistancePercent: 0,
  restingChunkBaseAmount: 0.5,
  repriceIntervalMs: 1000,
}

const startMessage: Extract<MainToWorker, { kind: 'start' }> = {
  kind: 'start',
  id: 'chase-1',
  strategyKind: 'chase-limit',
  config,
  createdAt: 0,
}

type ResentFields = { transaction_time?: number; block_height?: number; timestamp?: number }

const resting = (overrides: Partial<Order> & ResentFields = {}): WsOrder =>
  wsOrder({ order_id: '7', remaining_base_amount: 0.5, initial_base_amount: 0.5, ...overrides })[0]

it('passes on only the order updates that change a working order', async () => {
  const post = vi.fn()
  const worker = new StrategyWorker({
    clock,
    post,
    strategyWorkerConfig,
    signersReady: Promise.resolve(),
  })
  worker.authenticate({
    kind: 'authenticate',
    signer: { seed: 'seed', accountIndex: 5, apiKeyIndex: 4, chainId: 300 },
    isPoolAccount: false,
  })
  let workingOrder: Order = resting()
  const onFillUpdate = vi.fn(({ restingOrder }: { restingOrder: Order }) => {
    workingOrder = restingOrder
  })
  mocks.createEngine.mockReturnValueOnce({
    getProgress: () => ({ status: 'running' }),
    getWorkingOrders: () => ({ [workingOrder.order_id]: workingOrder }),
    onFillUpdate,
    start: vi.fn(),
    stop: vi.fn(),
  })
  await worker.start(startMessage)

  mocks.onOrder(resting({ transaction_time: 1 }))
  mocks.onOrder(resting({ transaction_time: 2, block_height: 10 }))
  mocks.onOrder(resting({ transaction_time: 3, updated_at: 11, timestamp: 12 }))
  const filled = resting({
    transaction_time: 4,
    filled_base_amount: 0.2,
    filled_quote_amount: 400,
    remaining_base_amount: 0.3,
  })
  mocks.onOrder(filled)
  mocks.onOrder(resting({ ...filled, transaction_time: 5 }))
  const untracked = resting({ order_id: '8', transaction_time: 6 })
  mocks.onOrder(untracked)

  expect(onFillUpdate.mock.calls).toEqual([
    [{ restingOrder: filled }],
    [{ restingOrder: untracked }],
  ])
})
