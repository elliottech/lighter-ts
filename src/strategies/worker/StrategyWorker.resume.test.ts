import type { ChaseLimitStrategyRecord, Clock, TwapStrategyRecord } from '../engine/types'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  persisted: {} as Record<string, unknown>,
  loaded: true,
}))

vi.mock('../store/strategyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/strategyStore')>()
  let hydrated = false
  Object.assign(actual.useStrategyStore, {
    persist: {
      rehydrate: () => {
        if (mocks.loaded) actual.useStrategyStore.setState({ strategies: mocks.persisted as never })
        hydrated = mocks.loaded
        return Promise.resolve()
      },
      hasHydrated: () => hydrated,
    },
  })
  return actual
})
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
  configureWorkerExceptions: vi.fn(),
}))
vi.mock('./WorkerMarketData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./WorkerMarketData')>()),
  WorkerMarketData: class {},
}))
vi.mock('./makeOrderClient', () => ({ makeOrderClient: () => ({}) }))
vi.mock('./WorkerWebsocket', () => ({
  WorkerWebsocket: class {
    start() {}
  },
  makeIsWorkerPriceFeedLive: () => () => true,
}))

const workingOrder = { order_id: '7', market_index: 1, client_order_index: 70 }

const chaseRecord = (id: string, status: 'running' | 'completed'): ChaseLimitStrategyRecord => ({
  id,
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
    status,
    totalBaseAmount: 1,
    filledBaseAmount: 0.25,
    filledQuoteAmount: 25,
    makerBaseAmount: 0.25,
    nextActionAt: null,
  },
  workingOrders: { '7': workingOrder as never },
  createdAt: 1000,
})

const twapRecord = (): TwapStrategyRecord =>
  ({
    id: 'twap-1',
    kind: 'advanced-twap',
    config: { accountIndex: 5, marketId: 1, totalSize: 2 },
    progress: {
      status: 'running',
      filledBaseAmount: 0.5,
      filledQuoteAmount: 50,
      makerBaseAmount: 0,
      failedBaseAmount: 0.1,
      consumedSlices: 3,
    },
    workingOrders: {},
    createdAt: 2000,
  }) as unknown as TwapStrategyRecord

const strategyWorkerConfig: StrategyWorkerConfig = {
  customServer: null,
  encoding: 'msgpack',
  env: 'staging',
  restApiBase: 'https://api.test',
  wsApiBase: 'wss://api.test/stream',
  wsPingIntervalMs: 2500,
  wsPongTimeoutMs: 12000,
}

const clock: Clock = { now: () => Date.now(), setTimeout, clearTimeout }

const { StrategyWorker } = await import('./StrategyWorker')

const newWorker = () => {
  const worker = new StrategyWorker({
    clock,
    post: vi.fn(),
    strategyWorkerConfig,
    signersReady: new Promise<void>(() => {}),
  })
  const start = vi.spyOn(worker, 'start').mockResolvedValue()
  return { worker, start }
}

beforeEach(() => {
  mocks.loaded = true
})

it('restarts each persisted running record with its resume state', async () => {
  mocks.persisted = {
    'chase-1': chaseRecord('chase-1', 'running'),
    'chase-2': chaseRecord('chase-2', 'completed'),
    'twap-1': twapRecord(),
  }
  const { worker, start } = newWorker()

  await worker.resumeRunningStrategies()

  expect(start).toHaveBeenCalledTimes(2)
  expect(start).toHaveBeenCalledWith({
    kind: 'start',
    id: 'chase-1',
    strategyKind: 'chase-limit',
    config: chaseRecord('chase-1', 'running').config,
    createdAt: 1000,
    resume: {
      filledBaseAmount: 0.25,
      filledQuoteAmount: 25,
      makerBaseAmount: 0.25,
      workingOrders: { '7': workingOrder },
    },
  })
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'twap-1',
      createdAt: 2000,
      resume: {
        filledBaseAmount: 0.5,
        filledQuoteAmount: 50,
        makerBaseAmount: 0,
        workingOrders: {},
        failedBaseAmount: 0.1,
        consumedSlices: 3,
      },
    }),
  )
})

it('restarts nothing when the records failed to load', async () => {
  mocks.loaded = false
  mocks.persisted = { 'chase-1': chaseRecord('chase-1', 'running') }
  const { worker, start } = newWorker()

  await worker.resumeRunningStrategies()

  expect(start).not.toHaveBeenCalled()
})
