import type { ChaseLimitStrategyRecord, Clock } from '../engine/types'
import type { MainToWorker, WorkerToMain } from './protocol'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { beforeEach, expect, it, vi } from 'vitest'
import { StrategyWorker } from './StrategyWorker'
import { freshStrategyRecord } from './freshStrategyRecord'
import { useStrategyStore } from '../store/strategyStore'

const mocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
  refreshStrategyUserTier: vi.fn(() => Promise.resolve()),
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
    getMarkPrice = () => 100
    getMidPrice = () => 100
    getBestBidPrice = () => 99
    getBestAskPrice = () => 101
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
    start() {}
    connect() {}
  },
  makeIsWorkerPriceFeedLive: () => () => true,
}))
vi.mock('./workerAccountFees', () => ({
  initWorkerAccountFees: () => Promise.resolve(),
  refreshStrategyUserTier: mocks.refreshStrategyUserTier,
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
  totalSize: 10,
  reduceOnly: false,
  maxDistancePercent: 0,
  restingChunkBaseAmount: 1,
  repriceIntervalMs: 1000,
}

const startMessage = (
  overrides: Partial<Extract<MainToWorker, { kind: 'start' }>> = {},
): Extract<MainToWorker, { kind: 'start' }> => ({
  kind: 'start',
  id: 'chase-1',
  strategyKind: 'chase-limit',
  config,
  createdAt: 0,
  ...overrides,
})

const newWorker = (maxStrategyNotional?: number) => {
  const post = vi.fn<(message: WorkerToMain) => void>()
  const worker = new StrategyWorker({
    clock,
    post,
    strategyWorkerConfig,
    signersReady: Promise.resolve(),
    maxStrategyNotional,
  })
  worker.authenticate({
    kind: 'authenticate',
    signer: { seed: 'seed', accountIndex: 5, apiKeyIndex: 4, chainId: 300 },
    isPoolAccount: false,
  })
  const engine = {
    getProgress: () => ({ status: 'running' }),
    getWorkingOrders: () => ({}),
    onFillUpdate: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
  mocks.createEngine.mockReturnValueOnce(engine)
  return { worker, post, engine }
}

const abortedEvents = (post: ReturnType<typeof vi.fn<(message: WorkerToMain) => void>>) =>
  post.mock.calls.flatMap(([message]) =>
    message.kind === 'event' &&
    message.event.type === 'status' &&
    message.event.status === 'aborted'
      ? [message.event.reason]
      : [],
  )

beforeEach(() => {
  mocks.createEngine.mockReset()
  mocks.refreshStrategyUserTier.mockImplementation(() => Promise.resolve())
  useStrategyStore.setState({ strategies: {} })
})

it('aborts a new strategy whose notional at the best ask is above the maximum', async () => {
  const { worker, post, engine } = newWorker(1000)

  await worker.start(startMessage())

  expect(mocks.createEngine).not.toHaveBeenCalled()
  expect(engine.start).not.toHaveBeenCalled()
  expect(abortedEvents(post)).toEqual([
    'Strategy notional of about 1010 exceeds the maximum of 1000',
  ])
})

it('starts a new strategy whose notional at the best bid is within the maximum', async () => {
  const { worker, post, engine } = newWorker(990)

  await worker.start(startMessage({ config: { ...config, isAsk: 1 } }))

  expect(engine.start).toHaveBeenCalledOnce()
  expect(abortedEvents(post)).toEqual([])
})

it('aborts a new chase whose config carries a zero limitPrice', async () => {
  const { worker, post, engine } = newWorker(1000)

  await worker.start(startMessage({ config: { ...config, limitPrice: 0 } as typeof config }))

  expect(engine.start).not.toHaveBeenCalled()
  expect(abortedEvents(post)).toEqual([
    'Strategy notional of about 1010 exceeds the maximum of 1000',
  ])
})

it('resumes a strategy above the maximum', async () => {
  const { worker, engine } = newWorker(1000)
  const resume = {
    filledBaseAmount: 0,
    filledQuoteAmount: 0,
    makerBaseAmount: 0,
    workingOrders: {},
  }

  await worker.start(startMessage({ resume }))

  expect(engine.start).toHaveBeenCalledOnce()
})

it('starts any size without a maximum', async () => {
  const { worker, engine } = newWorker()

  await worker.start(startMessage({ config: { ...config, totalSize: 1_000_000 } }))

  expect(engine.start).toHaveBeenCalledOnce()
})

it('stores the record it builds, not the one a start carries', async () => {
  const { worker } = newWorker(1000)
  const small = startMessage({ id: 'a', config: { ...config, totalSize: 1 } })
  const record = {
    ...freshStrategyRecord(startMessage({ id: 'b', config: { ...config, totalSize: 1_000_000 } })),
    workingOrders: { '7': {} },
  } as unknown as ChaseLimitStrategyRecord

  await worker.start({ ...small, record })

  // createdAt is reset to the worker's clock once the engine starts.
  const { strategies } = useStrategyStore.getState()
  expect(Object.keys(strategies)).toEqual(['a'])
  expect({ ...strategies.a, createdAt: 0 }).toEqual(freshStrategyRecord(small))
})

it('stores a new start only once its checks pass', async () => {
  let releaseTier = () => {}
  mocks.refreshStrategyUserTier.mockImplementation(
    () => new Promise<void>((resolve) => (releaseTier = resolve)),
  )
  const { worker, engine } = newWorker(1000)
  const started = worker.start(startMessage({ config: { ...config, isAsk: 1 } }))

  await vi.waitFor(() => expect(mocks.refreshStrategyUserTier).toHaveBeenCalled())
  expect(useStrategyStore.getState().strategies).toEqual({})
  releaseTier()
  await started

  expect(engine.start).toHaveBeenCalledOnce()
  expect(useStrategyStore.getState().strategies['chase-1']?.progress.status).toBe('running')
})

it('stores a new start above the maximum only as aborted, in one write', async () => {
  const { worker, post } = newWorker(1000)
  const written: (string | undefined)[] = []
  const unsubscribe = useStrategyStore.subscribe((state) =>
    written.push(state.strategies['chase-1']?.progress.status),
  )

  await worker.start(startMessage())
  unsubscribe()

  expect(written).toEqual(['aborted'])

  expect(abortedEvents(post)).toEqual([
    'Strategy notional of about 1010 exceeds the maximum of 1000',
  ])
  expect(useStrategyStore.getState().strategies['chase-1']?.progress.status).toBe('aborted')
})
