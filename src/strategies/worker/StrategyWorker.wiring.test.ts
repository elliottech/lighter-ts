import { expect, it, vi } from 'vitest'

import type { Clock } from '../engine/types'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'

const mocks = vi.hoisted(() => ({
  marketDataArgs: [] as unknown[][],
  isWorkerPriceFeedLive: () => true,
}))

const pending = () => new Promise<void>(() => {})

vi.mock('../engine/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/errors')>()),
  formatUnknownError: String,
}))
vi.mock('../..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../..')>()),
  selectOrderById: vi.fn(),
  useLighterStore: { getState: vi.fn(), setState: vi.fn() },
}))
vi.mock('../orderSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderSnapshot')>()),
  fetchOrderSnapshot: vi.fn(),
}))
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
  configureWorkerExceptions: vi.fn(),
}))
vi.mock('./factories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./factories')>()),
  createEngine: vi.fn(),
}))
vi.mock('./WorkerMarketData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./WorkerMarketData')>()),
  WorkerMarketData: class {
    constructor(...args: unknown[]) {
      mocks.marketDataArgs.push(args)
    }
  },
}))
vi.mock('./workerAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerAuth')>()),
  assertWorkerAccount: vi.fn(),
  authenticateWorker: vi.fn(),
  isWorkerRegistered: vi.fn(),
}))
vi.mock('../store/strategyStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/strategyStore')>()),
  useStrategyStore: {
    persist: { rehydrate: pending, hasHydrated: () => false },
  },
}))
vi.mock('./creditOrderTradeVolumesV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./creditOrderTradeVolumesV2')>()),
  creditClosingOrderFillDelta: vi.fn(),
  creditOrderTradeVolumesV2: vi.fn(),
}))
vi.mock('./makeEventListener', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./makeEventListener')>()),
  makeEventListener: vi.fn(),
}))
vi.mock('./workerIdle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerIdle')>()),
  configureWorkerIdle: vi.fn(),
  markWorkerBusy: vi.fn(),
  scheduleWorkerIdleCheck: vi.fn(),
  trackWorkerTask: vi.fn(),
}))
vi.mock('../orderLifecycle', () => ({
  cancelOrderUntilTerminalState: vi.fn(),
}))
vi.mock('./makeOrderClient', () => ({ makeOrderClient: vi.fn() }))
vi.mock('./WorkerWebsocket', () => ({
  WorkerWebsocket: class {
    start() {}
  },
  makeIsWorkerPriceFeedLive: () => mocks.isWorkerPriceFeedLive,
}))
vi.mock('./workerAccountFees', () => ({
  initWorkerAccountFees: vi.fn(),
  refreshStrategyUserTier: vi.fn(),
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

// The first import loads the worker's whole module graph, about 3-4s cold, so
// the 5s default fails under a loaded parallel run.
it('gives the engines market data that knows whether the price feed is live', {
  timeout: 30_000,
}, async () => {
  const { StrategyWorker } = await import('./StrategyWorker')
  new StrategyWorker({ clock, post: vi.fn(), strategyWorkerConfig, signersReady: pending() })

  expect(mocks.marketDataArgs).toHaveLength(1)
  expect(mocks.marketDataArgs[0]?.[1]).toBe(mocks.isWorkerPriceFeedLive)
})
