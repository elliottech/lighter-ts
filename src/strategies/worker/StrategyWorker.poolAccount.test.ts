import type { ChaseLimitStrategyRecord, Clock } from '../engine/types'
import type { MainToWorker, WorkerToMain } from './protocol'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { beforeEach, expect, it, vi } from 'vitest'
import { freshStrategyRecord } from './freshStrategyRecord'
import { useStrategyStore } from '../store/strategyStore'
import {
  DuplicateStrategyIdError,
  STRATEGY_POOL_ACCOUNT_ERROR,
  StrategyWorker,
} from './StrategyWorker'
import { captureWorkerException } from './captureWorkerException'

const mocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
  fetchIsPoolAccount: vi.fn<(accountIndex: number) => Promise<boolean>>(),
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
  fetchIsPoolAccount: mocks.fetchIsPoolAccount,
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

const newWorker = ({
  refusePoolAccounts,
  isPoolAccount = false,
}: {
  refusePoolAccounts?: boolean
  isPoolAccount?: boolean
} = {}) => {
  const post = vi.fn<(message: WorkerToMain) => void>()
  const worker = new StrategyWorker({
    clock,
    post,
    strategyWorkerConfig,
    signersReady: Promise.resolve(),
    refusePoolAccounts,
  })
  worker.authenticate({
    kind: 'authenticate',
    signer: { seed: 'seed', accountIndex: 5, apiKeyIndex: 4, chainId: 300 },
    isPoolAccount,
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

const resume = {
  filledBaseAmount: 0,
  filledQuoteAmount: 0,
  makerBaseAmount: 0,
  workingOrders: {},
}

beforeEach(() => {
  useStrategyStore.setState({ strategies: {} })
  vi.mocked(captureWorkerException).mockClear()
  mocks.createEngine.mockReset()
  mocks.fetchIsPoolAccount.mockReset()
  mocks.fetchIsPoolAccount.mockResolvedValue(false)
})

it('aborts a new strategy when authenticate says the account is a pool', async () => {
  const { worker, post, engine } = newWorker({ refusePoolAccounts: true, isPoolAccount: true })

  await worker.start(startMessage())

  expect(mocks.createEngine).not.toHaveBeenCalled()
  expect(engine.start).not.toHaveBeenCalled()
  expect(abortedEvents(post)).toEqual([STRATEGY_POOL_ACCOUNT_ERROR])
})

it('aborts a new strategy when the backend says the account is a pool', async () => {
  mocks.fetchIsPoolAccount.mockResolvedValue(true)
  const { worker, post, engine } = newWorker({ refusePoolAccounts: true })

  await worker.start(startMessage())

  expect(mocks.fetchIsPoolAccount).toHaveBeenCalledWith(5)
  expect(engine.start).not.toHaveBeenCalled()
  expect(abortedEvents(post)).toEqual([STRATEGY_POOL_ACCOUNT_ERROR])
})

it('starts a new strategy on an account that is not a pool', async () => {
  const { worker, post, engine } = newWorker({ refusePoolAccounts: true })

  await worker.start(startMessage())

  expect(engine.start).toHaveBeenCalledOnce()
  expect(abortedEvents(post)).toEqual([])
})

it('resumes a strategy on a pool account', async () => {
  const { worker, engine } = newWorker({ refusePoolAccounts: true, isPoolAccount: true })

  await worker.start(startMessage({ resume }))

  expect(engine.start).toHaveBeenCalledOnce()
})

it('starts on a pool account, without asking the backend, unless pool accounts are refused', async () => {
  const { worker, engine } = newWorker({ isPoolAccount: true })

  await worker.start(startMessage())

  expect(mocks.fetchIsPoolAccount).not.toHaveBeenCalled()
  expect(engine.start).toHaveBeenCalledOnce()
})

const storedRecord: ChaseLimitStrategyRecord = {
  id: 'chase-1',
  kind: 'chase-limit',
  config,
  progress: {
    status: 'completed',
    totalBaseAmount: 10,
    filledBaseAmount: 10,
    filledQuoteAmount: 1000,
    makerBaseAmount: 10,
    nextActionAt: null,
  },
  workingOrders: {},
  createdAt: 1000,
}

it('refuses a new start whose id is in the store, keeping its record', async () => {
  useStrategyStore.setState({ strategies: { 'chase-1': storedRecord } })
  const { worker, post } = newWorker()

  await worker.start(startMessage({ record: freshStrategyRecord(startMessage()) }))

  expect(mocks.createEngine).not.toHaveBeenCalled()
  expect(useStrategyStore.getState().strategies['chase-1']).toEqual(storedRecord)
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'event' }))
  expect(captureWorkerException).toHaveBeenCalledWith(new DuplicateStrategyIdError('chase-1'), {
    id: 'chase-1',
    tags: { feature: 'strategy-worker-start' },
  })
})

it('refuses a new start whose id is still starting', async () => {
  useStrategyStore.setState({ strategies: {} })
  const { worker, engine } = newWorker()

  await Promise.all([worker.start(startMessage()), worker.start(startMessage())])

  expect(engine.start).toHaveBeenCalledOnce()
  expect(captureWorkerException).toHaveBeenCalledWith(
    new DuplicateStrategyIdError('chase-1'),
    expect.anything(),
  )
})

it('resumes a strategy whose id is in the store', async () => {
  useStrategyStore.setState({
    strategies: {
      'chase-1': { ...storedRecord, progress: { ...storedRecord.progress, filledBaseAmount: 1 } },
    },
  })
  const { worker, engine } = newWorker()

  await worker.start(startMessage({ resume: { ...resume, filledBaseAmount: 1 } }))

  expect(engine.start).toHaveBeenCalledOnce()
  expect(captureWorkerException).not.toHaveBeenCalled()
})

it('stores a new strategy on a pool account only as aborted', async () => {
  useStrategyStore.setState({ strategies: {} })
  const { worker, post } = newWorker({ refusePoolAccounts: true, isPoolAccount: true })
  const written: (string | undefined)[] = []
  const unsubscribe = useStrategyStore.subscribe((state) =>
    written.push(state.strategies['chase-1']?.progress.status),
  )

  await worker.start(startMessage())
  unsubscribe()

  expect(written).toEqual(['aborted'])
  expect(abortedEvents(post)).toEqual([STRATEGY_POOL_ACCOUNT_ERROR])
  expect(useStrategyStore.getState().strategies['chase-1']?.progress.status).toBe('aborted')
})
