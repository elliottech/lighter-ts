import type { ChaseLimitStrategyRecord, Clock } from '../engine/types'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  finishRehydrate: (_loaded?: boolean) => {},
}))

vi.mock('../store/strategyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/strategyStore')>()
  let hydrated = false
  Object.assign(actual.useStrategyStore, {
    persist: {
      rehydrate: () =>
        new Promise<void>((resolve) => {
          hydrated = false
          mocks.finishRehydrate = (loaded = true) => {
            // zustand's default merge: the persisted records replace the in-memory ones.
            if (loaded)
              actual.useStrategyStore.setState({ strategies: { 'chase-1': persistedRecord() } })
            hydrated = loaded
            resolve()
          }
        }),
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

const persistedRecord = (): ChaseLimitStrategyRecord => ({
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
    status: 'completed',
    totalBaseAmount: 1,
    filledBaseAmount: 1,
    filledQuoteAmount: 100,
    makerBaseAmount: 1,
    nextActionAt: null,
  },
  workingOrders: {},
  createdAt: 0,
})

const strategyWorkerConfig: StrategyWorkerConfig = {
  customServer: null,
  encoding: 'msgpack',
  env: 'staging',
  restApiBase: 'https://api.test',
  wsApiBase: 'wss://api.test/stream',
  wsPingIntervalMs: 2500,
  wsPongTimeoutMs: 12000,
}

const clock: Clock = {
  now: () => Date.now(),
  setTimeout,
  clearTimeout,
}

const { useStrategyStore } = await import('../store/strategyStore')
const { StrategyWorker } = await import('./StrategyWorker')

const flushMacrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

it('a remove that arrives before the records load deletes the persisted record, and idle waits for it', async () => {
  const worker = new StrategyWorker({
    clock,
    post: mocks.postMessage,
    strategyWorkerConfig,
    signersReady: new Promise<void>(() => {}),
  })

  worker.remove({ kind: 'remove', id: 'chase-1' })
  await flushMacrotasks()
  expect(mocks.postMessage).not.toHaveBeenCalledWith({ kind: 'idle' })

  mocks.finishRehydrate()
  await flushMacrotasks()

  expect(useStrategyStore.getState().strategies['chase-1']).toBeUndefined()
  await vi.waitFor(() => expect(mocks.postMessage).toHaveBeenCalledWith({ kind: 'idle' }))
})

it('a remove does not write the store when the records failed to load', async () => {
  const worker = new StrategyWorker({
    clock,
    post: mocks.postMessage,
    strategyWorkerConfig,
    signersReady: new Promise<void>(() => {}),
  })
  const remove = vi.spyOn(useStrategyStore.getState(), 'remove')

  worker.remove({ kind: 'remove', id: 'chase-1' })
  mocks.finishRehydrate(false)
  await flushMacrotasks()

  expect(remove).not.toHaveBeenCalled()
})

const startMessage = () => ({
  kind: 'start' as const,
  id: 'chase-1',
  strategyKind: 'chase-limit' as const,
  config: persistedRecord().config,
  createdAt: 0,
  record: persistedRecord(),
})

const abortedEvent = (reason: string) => ({
  kind: 'event',
  id: 'chase-1',
  event: { type: 'status', status: 'aborted', reason, record: undefined },
})

it('a start aborted because the records failed to load reports the abort without writing the store', async () => {
  mocks.postMessage.mockClear()
  const worker = new StrategyWorker({
    clock,
    post: mocks.postMessage,
    strategyWorkerConfig,
    signersReady: new Promise<void>(() => {}),
  })
  const state = useStrategyStore.getState()
  const patchProgress = vi.spyOn(state, 'patchProgress')
  const upsert = vi.spyOn(state, 'upsert')

  const started = worker.start(startMessage())
  mocks.finishRehydrate(false)
  await started

  expect(upsert).not.toHaveBeenCalled()
  expect(patchProgress).not.toHaveBeenCalled()
  expect(mocks.postMessage).toHaveBeenCalledWith(abortedEvent('Failed to load the strategy store'))
})

it('a stop during a start whose records failed to load reports the abort without writing the store', async () => {
  mocks.postMessage.mockClear()
  const worker = new StrategyWorker({
    clock,
    post: mocks.postMessage,
    strategyWorkerConfig,
    signersReady: new Promise<void>(() => {}),
  })
  const patchProgress = vi.spyOn(useStrategyStore.getState(), 'patchProgress')

  const started = worker.start(startMessage())
  worker.stop({ kind: 'stop', id: 'chase-1', reason: 'Stopped by user' })
  mocks.finishRehydrate(false)
  await started

  expect(patchProgress).not.toHaveBeenCalled()
  expect(mocks.postMessage).toHaveBeenCalledWith(abortedEvent('Stopped by user'))
})
