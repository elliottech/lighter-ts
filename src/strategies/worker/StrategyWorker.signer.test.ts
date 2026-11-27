import type { ChaseLimitStrategyRecord, Clock } from '../engine/types'
import type { MainToWorker } from './protocol'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StrategyWorker, TIER_REFRESH_WAIT_MS } from './StrategyWorker'
import { SignerRejectedError } from './workerAuth'
import { useStrategyStore } from '../store/strategyStore'

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
  createEngine: vi.fn(),
  connect: vi.fn(),
  findWorkerSignerKeyError: vi.fn<() => Promise<string | null>>(),
  authenticateWorker: vi.fn<() => Promise<number>>(() => Promise.resolve(5)),
  hasPrice: false,
  onOpenFailed: (() => {}) as () => void,
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
    hasPrice = () => mocks.hasPrice
    initializeMarketMetas = () => Promise.resolve()
    waitForPrice = (_marketId: number, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error))
      })
  },
}))
vi.mock('./workerAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerAuth')>()),
  assertWorkerAccount: () => {},
  authenticateWorker: mocks.authenticateWorker,
  isWorkerRegistered: () => true,
  findWorkerSignerKeyError: mocks.findWorkerSignerKeyError,
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
      mocks.onOpenFailed = args[7] as () => void
    }
    start() {}
    connect = mocks.connect
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

const startMessage = (id: string): Extract<MainToWorker, { kind: 'start' }> => ({
  kind: 'start',
  id,
  strategyKind: 'chase-limit',
  config,
  createdAt: 0,
})

const resumeMessage = (id: string): Extract<MainToWorker, { kind: 'start' }> => ({
  ...startMessage(id),
  resume: { filledBaseAmount: 0, filledQuoteAmount: 0, makerBaseAmount: 0, workingOrders: {} },
})

const REVOKED = 'API key is no longer registered, authenticate again'

const startWorker = (onSignerRejected?: (error: string) => void) => {
  const post = vi.fn()
  const worker = new StrategyWorker({
    clock,
    post,
    strategyWorkerConfig,
    signersReady: Promise.resolve(),
    onSignerRejected,
  })
  worker.authenticate({
    kind: 'authenticate',
    signer: { seed: 'seed', accountIndex: 5, apiKeyIndex: 4, chainId: 300 },
    isPoolAccount: false,
  })
  return { worker, post }
}

const abortReason = (post: ReturnType<typeof vi.fn>, id: string) =>
  post.mock.calls
    .map(
      ([message]) =>
        message as { kind: string; id?: string; event?: { status?: string; reason?: string } },
    )
    .find((message) => message.id === id && message.event?.status === 'aborted')?.event?.reason

beforeEach(() => {
  useStrategyStore.setState({ strategies: {} })
})

describe('a signer revoked after init', () => {
  beforeEach(() => {
    mocks.createEngine.mockReset()
    mocks.connect.mockReset()
    mocks.findWorkerSignerKeyError.mockReset()
    mocks.hasPrice = false
  })

  it('aborts every running strategy when a request is rejected', async () => {
    const onSignerRejected = vi.fn()
    const { worker } = startWorker(onSignerRejected)
    mocks.hasPrice = true
    const makeEngine = () => ({
      getProgress: () => ({ status: 'running' }),
      start: vi.fn(),
      stop: vi.fn(),
    })
    const engines = [makeEngine(), makeEngine()]
    mocks.createEngine.mockReturnValueOnce(engines[0]).mockReturnValueOnce(engines[1])
    await worker.start(startMessage('chase-1'))
    await worker.start(startMessage('chase-2'))
    expect(mocks.createEngine).toHaveBeenCalledTimes(2)

    mocks.findWorkerSignerKeyError.mockResolvedValue(REVOKED)
    worker.checkSignerKey()
    await vi.waitFor(() => expect(onSignerRejected).toHaveBeenCalledExactlyOnceWith(REVOKED))

    for (const engine of engines) expect(engine.stop).toHaveBeenCalledExactlyOnceWith(REVOKED)
  })

  it('leaves running strategies alone when the key is still registered', async () => {
    const onSignerRejected = vi.fn()
    const { worker } = startWorker(onSignerRejected)
    mocks.hasPrice = true
    const engine = { getProgress: () => ({ status: 'running' }), start: vi.fn(), stop: vi.fn() }
    mocks.createEngine.mockReturnValueOnce(engine)
    await worker.start(startMessage('chase-1'))

    mocks.findWorkerSignerKeyError.mockResolvedValue(null)
    worker.checkSignerKey()
    await vi.waitFor(() => expect(mocks.findWorkerSignerKeyError).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(engine.stop).not.toHaveBeenCalled()
    expect(onSignerRejected).not.toHaveBeenCalled()
  })

  it('aborts the pending start and the next one with the key error', {
    timeout: 30_000,
  }, async () => {
    const onSignerRejected = vi.fn()
    const { worker, post } = startWorker(onSignerRejected)
    mocks.findWorkerSignerKeyError.mockResolvedValue(REVOKED)

    const pending = worker.start(startMessage('chase-1'))
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1))
    mocks.onOpenFailed()
    mocks.onOpenFailed()
    await pending

    expect(mocks.findWorkerSignerKeyError).toHaveBeenCalledTimes(1)
    expect(onSignerRejected).toHaveBeenCalledExactlyOnceWith(REVOKED)
    expect(abortReason(post, 'chase-1')).toBe(REVOKED)

    await worker.start(startMessage('chase-2'))
    expect(abortReason(post, 'chase-2')).toBe(REVOKED)
    expect(mocks.connect).toHaveBeenCalledTimes(1)
    expect(mocks.createEngine).not.toHaveBeenCalled()
  })

  it('keeps waiting when the key is still registered or the check fails', async () => {
    const onSignerRejected = vi.fn()
    startWorker(onSignerRejected)
    mocks.findWorkerSignerKeyError
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('offline'))

    mocks.onOpenFailed()
    await vi.waitFor(() => expect(mocks.findWorkerSignerKeyError).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    mocks.onOpenFailed()
    await vi.waitFor(() => expect(mocks.findWorkerSignerKeyError).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onSignerRejected).not.toHaveBeenCalled()
  })

  it('reports a signer rejected at init before initFailed', async () => {
    mocks.authenticateWorker.mockRejectedValueOnce(new SignerRejectedError(REVOKED))
    const onSignerRejected = vi.fn()
    const { post } = startWorker(onSignerRejected)

    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith({ kind: 'initFailed', error: REVOKED }),
    )
    expect(onSignerRejected).toHaveBeenCalledExactlyOnceWith(REVOKED)
    expect(onSignerRejected.mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder.at(-1) ?? 0,
    )
  })

  it('reports a failed init request without rejecting the signer', async () => {
    mocks.authenticateWorker.mockRejectedValueOnce(new Error('fetch failed'))
    const onSignerRejected = vi.fn()
    const { post } = startWorker(onSignerRejected)

    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith({ kind: 'initFailed', error: 'fetch failed' }),
    )
    expect(onSignerRejected).not.toHaveBeenCalled()
  })

  it('aborts a fresh start with the init error once authentication failed', async () => {
    mocks.authenticateWorker.mockRejectedValueOnce(new Error('fetch failed'))
    const { worker, post } = startWorker(vi.fn())

    await worker.start(startMessage('chase-1'))

    expect(abortReason(post, 'chase-1')).toBe('fetch failed')
    expect(mocks.createEngine).not.toHaveBeenCalled()
  })

  it('leaves a resumed start pending when an init request failed', async () => {
    mocks.authenticateWorker.mockRejectedValueOnce(new Error('fetch failed'))
    const { worker, post } = startWorker(vi.fn())

    await worker.start(resumeMessage('chase-1'))

    expect(abortReason(post, 'chase-1')).toBeUndefined()
    expect(mocks.createEngine).not.toHaveBeenCalled()
  })

  it('aborts a resumed start when the signer was rejected at init', async () => {
    mocks.authenticateWorker.mockRejectedValueOnce(new SignerRejectedError(REVOKED))
    const { worker, post } = startWorker(vi.fn())

    await worker.start(resumeMessage('chase-1'))

    expect(abortReason(post, 'chase-1')).toBe(REVOKED)
    expect(mocks.createEngine).not.toHaveBeenCalled()
  })

  it('does not check the key without onSignerRejected', () => {
    startWorker()
    mocks.onOpenFailed()
    expect(mocks.findWorkerSignerKeyError).not.toHaveBeenCalled()
  })
})

describe('the account tier on start', () => {
  beforeEach(() => {
    mocks.createEngine.mockReset()
    mocks.refreshStrategyUserTier.mockReset().mockResolvedValue(undefined)
    mocks.hasPrice = true
  })

  const makeEngine = () => ({
    getProgress: () => ({ status: 'running' }),
    start: vi.fn(),
    stop: vi.fn(),
  })

  it('reloads the tier before a new strategy places its first order', async () => {
    const { worker } = startWorker()
    let refreshed = () => {}
    mocks.refreshStrategyUserTier.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        refreshed = resolve
      }),
    )
    mocks.createEngine.mockReturnValueOnce(makeEngine())

    const started = worker.start(startMessage('chase-1'))
    await vi.waitFor(() => expect(mocks.refreshStrategyUserTier).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.createEngine).not.toHaveBeenCalled()

    refreshed()
    await started
    expect(mocks.createEngine).toHaveBeenCalledTimes(1)
  })

  it('starts on the last tier when the reload stalls', async () => {
    vi.useFakeTimers()
    try {
      const { worker } = startWorker()
      mocks.refreshStrategyUserTier.mockReturnValueOnce(new Promise<void>(() => {}))
      mocks.createEngine.mockReturnValueOnce(makeEngine())

      const started = worker.start(startMessage('chase-1'))
      await vi.advanceTimersByTimeAsync(TIER_REFRESH_WAIT_MS - 1)
      expect(mocks.createEngine).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await started
      expect(mocks.createEngine).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reload the tier for a resumed strategy', async () => {
    const { worker } = startWorker()
    mocks.createEngine.mockReturnValueOnce(makeEngine())

    await worker.start(resumeMessage('chase-1'))

    expect(mocks.createEngine).toHaveBeenCalledTimes(1)
    expect(mocks.refreshStrategyUserTier).not.toHaveBeenCalled()
  })
})
