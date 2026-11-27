import { describe, expect, it, vi } from 'vitest'
import type { StrategyRecord } from '../engine/types'
import { FakeClock } from '../engine/testUtils'
import type { ApiPublicKey } from './backendApiKey'
import type { PendingSigner, PendingStop, StoredSigner } from './serverDb'
import type { ServerToWorker } from './serverProtocol'
import type { MainToWorker } from '../worker/protocol'
import {
  WORKER_EXIT_TIMEOUT_MS,
  WORKER_RESPAWN_MAX_DELAY_MS,
  WORKER_RESPAWN_DELAY_MS,
  PENDING_SEED_REUSE_MS,
  REGISTRATION_POLL_MAX_MS,
  REGISTRATION_POLL_MS,
  STRATEGIES_WS_CLOSING_ERROR,
  STRATEGIES_WS_PAUSED_ERROR,
  STRATEGIES_WS_STARTING_ERROR,
  type WorkerProcessHandlers,
  createWorkerSupervisor,
  endWorkerProcess,
} from './workerSupervisor'

const SIGNER: StoredSigner = { seed: 'ab'.repeat(40), accountIndex: 7, apiKeyIndex: 3 }

const record = (id: string) => ({ id }) as unknown as StrategyRecord

const REGISTRATION = {
  accountIndex: 7,
  apiKeyIndex: 4,
  publicKey: 'ab'.repeat(40),
  nonce: 3,
  expiredAt: 600_000,
  txInfo: '{}',
}
const START = {
  kind: 'start',
  id: 'next',
  strategyKind: 'iceberg',
  config: {},
  createdAt: 0,
} as unknown as MainToWorker

/** The retry waits for the failed worker's exit before spawning. */
const killed = () => new Promise((resolve) => setTimeout(resolve))

interface FakeWorker {
  handlers: WorkerProcessHandlers
  sent: ServerToWorker[]
  killed: boolean
}

const make = (
  stored: StoredSigner | null = null,
  initialStops: PendingStop[] = [],
  persistedStrategies: Record<string, StrategyRecord> = {},
  startPaused = false,
  initialPending: PendingSigner | null = null,
) => {
  const clock = new FakeClock()
  let signer = stored
  let pending = initialPending
  const pendingStops = new Map(initialStops.map((stop) => [stop.id, stop]))
  const db = {
    readSigner: vi.fn(() => signer),
    readPendingSigner: vi.fn(() => pending),
    savePendingSigner: vi.fn((next: PendingSigner) => {
      pending = next
    }),
    adoptPendingSigner: vi.fn(() => {
      if (!pending) return null
      const { createdAt: _createdAt, ...adopted } = pending
      signer = adopted
      pending = null
      return adopted
    }),
    readPendingStops: vi.fn(() => [...pendingStops.values()]),
    savePendingStop: vi.fn((stop: PendingStop) => {
      pendingStops.set(stop.id, stop)
    }),
    deletePendingStop: vi.fn((id: string) => {
      pendingStops.delete(id)
    }),
  }
  const workers: FakeWorker[] = []
  const onWorkerMessage = vi.fn()
  const onError = vi.fn()
  const listed: { key: ApiPublicKey | null } = { key: null }
  const getPublicKey = vi.fn((_accountIndex: number, _apiKeyIndex: number) =>
    Promise.resolve(listed.key),
  )
  const supervisor = createWorkerSupervisor({
    db,
    chainId: 304,
    apiKeyIndex: 4,
    isPoolAccount: false,
    clock,
    persistedStrategies,
    startPaused,
    spawnWorker: (handlers) => {
      const worker: FakeWorker = { handlers, sent: [], killed: false }
      workers.push(worker)
      return {
        send: (message) => worker.sent.push(message),
        kill: () => {
          worker.killed = true
          return Promise.resolve()
        },
      }
    },
    getPublicKey,
    onWorkerMessage,
    onError,
  })
  /** The current worker's signer is rejected with a registration for `seed`, then a start restarts it. */
  const replace = async ({ seed = 'cd' }: { seed?: string } = {}) => {
    const current = workers.at(-1)
    current?.handlers.onMessage({ kind: 'signerFailed', error: 'key revoked' })
    current?.handlers.onMessage({ kind: 'registration', registration: { ...REGISTRATION, seed } })
    supervisor.send(START)
    await killed()
  }
  return {
    supervisor,
    replace,
    db,
    clock,
    workers,
    onWorkerMessage,
    onError,
    pendingStops,
    listed,
    getPublicKey,
  }
}

const authenticateOf = (signer: StoredSigner | null, seed: string | null = null) => ({
  kind: 'authenticate',
  signer: signer && { ...signer, chainId: 304 },
  isPoolAccount: false,
  registration: { accountIndex: 7, apiKeyIndex: 4, chainId: 304, seed },
})
const PENDING_CD = { seed: 'cd', accountIndex: 7, apiKeyIndex: 4 }

describe('createWorkerSupervisor', () => {
  it('starts no worker while no signer is stored', async () => {
    const { supervisor, workers } = make()

    expect(workers).toHaveLength(0)
    expect(supervisor.getAccountIndex()).toBeNull()
    expect(supervisor.getSignerStatus()).toBeNull()
    await expect(supervisor.send({ kind: 'stop', id: 's1' })).resolves.toBe(false)
  })

  it('authenticates the worker with the stored signer and reports its init', async () => {
    const { supervisor, workers, onWorkerMessage } = make(SIGNER)
    const statuses: string[] = []
    supervisor.subscribeSignerStatus((status) => statuses.push(status))

    expect(workers).toHaveLength(1)
    expect(workers[0]?.sent).toEqual([authenticateOf(SIGNER)])
    expect(supervisor.getAccountIndex()).toBe(7)
    expect(supervisor.getSignerStatus()).toBe('starting')

    workers[0]?.handlers.onMessage({ kind: 'initialised' })

    expect(supervisor.getSignerStatus()).toBe('ready')
    expect(statuses).toEqual(['ready'])
    expect(onWorkerMessage).toHaveBeenCalledWith({ kind: 'initialised' })
    await expect(supervisor.send({ kind: 'stop', id: 's1' })).resolves.toBe(true)
    expect(workers[0]?.sent.at(-1)).toEqual({ kind: 'stop', id: 's1' })
  })

  it('starts a worker without a signer for the first client account, once', () => {
    const { supervisor, workers } = make()

    supervisor.register(7)
    supervisor.register(8)

    expect(supervisor.getAccountIndex()).toBe(7)
    expect(workers).toHaveLength(1)
    expect(workers[0]?.sent).toEqual([authenticateOf(null)])
  })

  it('keeps the registration the worker signed as the pending signer and shows it without the seed', () => {
    const { supervisor, db, workers, clock } = make()
    const shown: unknown[] = []
    supervisor.subscribeRegistration((registration) => shown.push(registration))
    supervisor.register(7)
    clock.advance(1000)

    workers[0]?.handlers.onMessage({ kind: 'signerFailed', error: 'missing signer' })
    workers[0]?.handlers.onMessage({
      kind: 'registration',
      registration: { ...REGISTRATION, seed: 'cd' },
    })

    expect(db.savePendingSigner).toHaveBeenCalledWith({ ...PENDING_CD, createdAt: 1000 })
    expect(supervisor.getSignerStatus()).toBe('failed')
    expect(supervisor.getRegistration()).toEqual(REGISTRATION)
    expect(shown).toEqual([REGISTRATION])
  })

  it('keeps the creation time of a pending seed the worker signed again', () => {
    const { db, workers, clock } = make(SIGNER, [], {}, false, { ...PENDING_CD, createdAt: 0 })
    clock.advance(1000)

    workers[0]?.handlers.onMessage({
      kind: 'registration',
      registration: { ...REGISTRATION, seed: 'cd' },
    })
    expect(db.savePendingSigner).toHaveBeenLastCalledWith({ ...PENDING_CD, createdAt: 0 })

    workers[0]?.handlers.onMessage({
      kind: 'registration',
      registration: { ...REGISTRATION, seed: 'ef' },
    })
    expect(db.savePendingSigner).toHaveBeenLastCalledWith({
      ...PENDING_CD,
      seed: 'ef',
      createdAt: 1000,
    })
  })

  it('restarts a failed worker with the pending signer on a start, and adopts it once initialised', async () => {
    const { supervisor, replace, db, workers, onError } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'initialised' })

    await replace()

    expect(onError).toHaveBeenCalledWith(new Error('key revoked'))
    expect(workers[0]?.killed).toBe(true)
    expect(workers[1]?.sent).toEqual([authenticateOf(PENDING_CD, 'cd'), START])
    expect(supervisor.getSignerStatus()).toBe('starting')

    workers[1]?.handlers.onMessage({ kind: 'initialised' })

    expect(db.adoptPendingSigner).toHaveBeenCalledTimes(1)
    expect(db.readSigner()).toEqual(PENDING_CD)
    expect(supervisor.getRegistration()).toBeNull()
    expect(supervisor.getSignerStatus()).toBe('ready')
  })

  describe('once the frontend registered the key without a start', () => {
    const REGISTERED_KEY = { keyType: 0, publicKey: `0x${'AB'.repeat(40)}` }

    const rejected = () => {
      const made = make(SIGNER)
      made.workers[0]?.handlers.onMessage({ kind: 'initialised' })
      made.workers[0]?.handlers.onMessage({ kind: 'signerFailed', error: 'key revoked' })
      made.workers[0]?.handlers.onMessage({
        kind: 'registration',
        registration: { ...REGISTRATION, seed: 'cd' },
      })
      return made
    }

    const poll = async (clock: FakeClock) => {
      clock.fireNext()
      await killed()
    }

    it('restarts the worker with the pending signer once Lighter lists its key', async () => {
      const { supervisor, db, clock, workers, listed, getPublicKey } = rejected()

      await poll(clock)
      expect(getPublicKey).toHaveBeenLastCalledWith(7, 4)
      expect(clock.now()).toBe(REGISTRATION_POLL_MS)
      expect(workers).toHaveLength(1)

      listed.key = REGISTERED_KEY
      await poll(clock)

      expect(workers[0]?.killed).toBe(true)
      expect(workers[1]?.sent).toEqual([authenticateOf(PENDING_CD, 'cd')])
      workers[1]?.handlers.onMessage({ kind: 'initialised' })
      expect(db.readSigner()).toEqual(PENDING_CD)
      expect(supervisor.getRegistration()).toBeNull()
      expect(supervisor.getSignerStatus()).toBe('ready')
      expect(clock.pendingCount()).toBe(0)
    })

    it('stops checking 10 minutes after the registration', async () => {
      const { clock, workers, getPublicKey } = rejected()

      while (clock.pendingCount() > 0) await poll(clock)

      expect(getPublicKey).toHaveBeenCalledTimes(REGISTRATION_POLL_MAX_MS / REGISTRATION_POLL_MS)
      expect(clock.now()).toBe(REGISTRATION_POLL_MAX_MS)
      expect(workers).toHaveLength(1)
    })

    it('keeps checking after a failed lookup', async () => {
      const { clock, workers, listed, getPublicKey } = rejected()
      getPublicKey.mockRejectedValueOnce(new Error('HTTP 502'))

      await poll(clock)
      listed.key = REGISTERED_KEY
      await poll(clock)

      expect(workers).toHaveLength(2)
    })

    it('ignores a key other than the pending one', async () => {
      const { clock, workers, listed } = rejected()
      listed.key = { keyType: 0, publicKey: 'ef'.repeat(40) }

      await poll(clock)

      expect(workers).toHaveLength(1)
      expect(clock.pendingCount()).toBe(1)
    })

    it('stops checking once a start restarted the worker and it initialised', async () => {
      const { supervisor, clock, workers, getPublicKey } = rejected()

      await supervisor.send(START)
      workers[1]?.handlers.onMessage({ kind: 'initialised' })
      while (clock.pendingCount() > 0) await poll(clock)

      expect(getPublicKey).not.toHaveBeenCalled()
    })

    it('restarts a worker that rejected the pending seed before Lighter listed its key', async () => {
      const { supervisor, clock, workers, listed, replace } = make(SIGNER)
      workers[0]?.handlers.onMessage({ kind: 'initialised' })
      await replace()
      workers[1]?.handlers.onMessage({ kind: 'signerFailed', error: 'key not registered' })
      workers[1]?.handlers.onMessage({
        kind: 'registration',
        registration: { ...REGISTRATION, seed: 'cd' },
      })
      await poll(clock)
      expect(workers).toHaveLength(2)
      listed.key = REGISTERED_KEY

      await poll(clock)

      expect(workers).toHaveLength(3)
      expect(workers[2]?.sent).toEqual([authenticateOf(PENDING_CD, 'cd')])
      workers[2]?.handlers.onMessage({ kind: 'initialised' })
      expect(supervisor.getSignerStatus()).toBe('ready')
    })

    it('restarts once per seed, when the worker rejects it after Lighter listed its key', async () => {
      const { clock, workers, listed } = rejected()
      listed.key = REGISTERED_KEY
      await poll(clock)
      expect(workers).toHaveLength(2)

      workers[1]?.handlers.onMessage({ kind: 'signerFailed', error: 'key mismatch' })
      workers[1]?.handlers.onMessage({
        kind: 'registration',
        registration: { ...REGISTRATION, seed: 'cd' },
      })
      await poll(clock)

      expect(workers).toHaveLength(2)
    })

    it('stops checking during a pause, and resumes with the pending signer', async () => {
      const { supervisor, clock, workers, listed, getPublicKey } = rejected()
      await supervisor.pause()
      listed.key = REGISTERED_KEY

      expect(clock.pendingCount()).toBe(0)
      expect(getPublicKey).not.toHaveBeenCalled()

      supervisor.resume()

      expect(workers).toHaveLength(2)
      expect(workers[1]?.sent).toEqual([authenticateOf(PENDING_CD, 'cd')])
    })

    it('drops a lookup that answers after a pause', async () => {
      const { supervisor, clock, workers, getPublicKey } = rejected()
      let answer: (key: ApiPublicKey | null) => void = () => {}
      getPublicKey.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve
        }),
      )
      clock.fireNext()
      await supervisor.pause()

      answer(REGISTERED_KEY)
      await killed()

      expect(workers).toHaveLength(1)
      expect(clock.pendingCount()).toBe(0)
    })
  })

  it('does not adopt a signer it did not start with a pending one', () => {
    const { db, workers } = make(SIGNER)

    workers[0]?.handlers.onMessage({ kind: 'initialised' })

    expect(db.adoptPendingSigner).not.toHaveBeenCalled()
  })

  it('signs for the pending seed again only while it is younger than 5 minutes', () => {
    const pending = { ...PENDING_CD, createdAt: 0 }
    const young = make(SIGNER, [], {}, true, pending)
    young.clock.advance(PENDING_SEED_REUSE_MS - 1)
    young.supervisor.resume()
    expect(young.workers[0]?.sent).toEqual([authenticateOf(PENDING_CD, 'cd')])

    const old = make(SIGNER, [], {}, true, pending)
    old.clock.advance(PENDING_SEED_REUSE_MS)
    old.supervisor.resume()
    expect(old.workers[0]?.sent).toEqual([authenticateOf(PENDING_CD, null)])
  })

  it('resolves the commands sent while the worker restarts once the new worker has them', async () => {
    const { supervisor, workers } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'signerFailed', error: 'key revoked' })

    const start = supervisor.send(START)
    const stop = supervisor.send({ kind: 'stop', id: 's1' })

    await expect(start).resolves.toBe(true)
    await expect(stop).resolves.toBe(true)
    expect(workers[1]?.sent).toEqual([authenticateOf(SIGNER), START, { kind: 'stop', id: 's1' }])
  })

  it('keeps a stop and rejects a start sent while the worker restarts, when it is paused meanwhile', async () => {
    const { supervisor, workers, db } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'signerFailed', error: 'key revoked' })

    const start = supervisor.send(START)
    const stop = supervisor.send({ kind: 'stop', id: 's1' })
    supervisor.pause()

    await expect(start).resolves.toBe(STRATEGIES_WS_PAUSED_ERROR)
    await expect(stop).resolves.toBe(true)
    expect(workers).toHaveLength(1)
    expect(db.savePendingStop).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))

    supervisor.resume()
    expect(workers[1]?.sent).toContainEqual(expect.objectContaining({ kind: 'stop', id: 's1' }))
  })

  it('keeps a stop and rejects a start sent while the worker restarts, when it is closed meanwhile', async () => {
    const { supervisor, workers, db } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'signerFailed', error: 'key revoked' })

    const start = supervisor.send(START)
    const stop = supervisor.send({ kind: 'stop', id: 's1' })
    void supervisor.close()

    await expect(start).resolves.toBe(STRATEGIES_WS_CLOSING_ERROR)
    await expect(stop).resolves.toBe(true)
    expect(workers).toHaveLength(1)
    expect(db.savePendingStop).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }))
  })

  it('forwards a start to a worker whose signer did not fail', () => {
    const { supervisor, workers } = make(SIGNER)

    supervisor.send(START)

    expect(workers).toHaveLength(1)
    expect(workers[0]?.sent.at(-1)).toEqual(START)
  })

  it('mirrors the worker records and keeps them until a new worker reports its store', async () => {
    const { supervisor, replace, workers } = make(SIGNER)
    const changes: string[][] = []
    supervisor.subscribeStrategies((next) => changes.push(Object.keys(next)))

    workers[0]?.handlers.onMessage({
      kind: 'strategies',
      strategies: [record('a'), record('b')],
      removed: [],
    })
    workers[0]?.handlers.onMessage({ kind: 'strategies', strategies: [], removed: ['a'] })
    expect(supervisor.getStrategies()).toEqual({ b: record('b') })

    workers[0]?.handlers.onMessage({ kind: 'initFailed', error: 'expired' })
    await replace()
    expect(supervisor.getStrategies()).toEqual({ b: record('b') })

    workers[1]?.handlers.onMessage({ kind: 'strategies', strategies: [record('c')], removed: [] })
    expect(supervisor.getStrategies()).toEqual({ c: record('c') })
    workers[1]?.handlers.onMessage({ kind: 'strategies', strategies: [record('d')], removed: [] })
    expect(supervisor.getStrategies()).toEqual({ c: record('c'), d: record('d') })
    expect(changes).toEqual([['a', 'b'], ['b'], ['c'], ['c', 'd']])
  })

  it('ignores the messages and exit of a replaced worker', async () => {
    const { supervisor, replace, workers, onError, clock } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'initFailed', error: 'expired' })
    await replace()
    onError.mockClear()

    workers[0]?.handlers.onMessage({ kind: 'initialised' })
    workers[0]?.handlers.onMessage({ kind: 'strategies', strategies: [record('a')], removed: [] })
    workers[0]?.handlers.onExit(null)

    expect(supervisor.getSignerStatus()).toBe('starting')
    expect(supervisor.getStrategies()).toEqual({})
    expect(onError).not.toHaveBeenCalled()
    expect(clock.pendingCount()).toBe(0)
  })

  it('respawns a worker that exited on its own', async () => {
    const { supervisor, workers, onError, clock } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'initialised' })

    workers[0]?.handlers.onExit(1)

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'The strategies worker exited with code 1' }),
    )
    expect(supervisor.getSignerStatus()).toBe('starting')
    await expect(supervisor.send({ kind: 'stop', id: 's1' })).resolves.toBe(false)
    expect(clock.nextDueAt()).toBe(WORKER_RESPAWN_DELAY_MS)
    clock.fireNext()
    expect(workers).toHaveLength(2)
    expect(workers[1]?.sent).toEqual([authenticateOf(SIGNER)])

    workers[1]?.handlers.onExit(1)
    expect(clock.nextDueAt()! - clock.now()).toBe(2 * WORKER_RESPAWN_DELAY_MS)
    clock.fireNext()
    workers[2]?.handlers.onMessage({ kind: 'initialised' })
    workers[2]?.handlers.onExit(1)
    expect(clock.nextDueAt()! - clock.now()).toBe(WORKER_RESPAWN_DELAY_MS)
  })

  it('retries an init that failed on a request, with a growing delay', async () => {
    const { supervisor, workers, clock } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'initFailed', error: 'Response returned an error code' })
    expect(supervisor.getSignerStatus()).toBe('failed')
    expect(clock.nextDueAt()).toBe(WORKER_RESPAWN_DELAY_MS)

    clock.fireNext()
    await killed()
    expect(workers[0]?.killed).toBe(true)
    expect(workers).toHaveLength(2)
    expect(workers[1]?.sent).toEqual([authenticateOf(SIGNER)])
    expect(supervisor.getSignerStatus()).toBe('starting')

    workers[1]?.handlers.onMessage({ kind: 'initFailed', error: 'Response returned an error code' })
    expect(clock.nextDueAt()).toBe(WORKER_RESPAWN_DELAY_MS + 2 * WORKER_RESPAWN_DELAY_MS)
    for (let attempt = 2; clock.pendingCount() > 0 && attempt < 12; attempt++) {
      clock.fireNext()
      await killed()
      workers[attempt]?.handlers.onMessage({ kind: 'initFailed', error: 'fetch failed' })
    }
    const [secondToLast, last] = [workers.at(-2), workers.at(-1)]
    expect(last).toBeDefined()
    expect(secondToLast).toBeDefined()
    expect(clock.nextDueAt()! - clock.now()).toBe(WORKER_RESPAWN_MAX_DELAY_MS)

    clock.fireNext()
    await killed()
    workers.at(-1)?.handlers.onMessage({ kind: 'initialised' })
    expect(supervisor.getSignerStatus()).toBe('ready')
    expect(clock.pendingCount()).toBe(0)
  })

  it('keeps one respawn when the worker exits after its init failed', async () => {
    const { supervisor, workers, clock } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'initFailed', error: 'fetch failed' })
    workers[0]?.handlers.onExit(1)
    expect(clock.pendingCount()).toBe(1)

    clock.fireNext()
    await killed()
    expect(workers).toHaveLength(2)
    workers[1]?.handlers.onMessage({ kind: 'initialised' })

    expect(clock.pendingCount()).toBe(0)
    expect(workers[1]?.killed).toBe(false)
    expect(supervisor.getSignerStatus()).toBe('ready')
  })

  it('starts a new signer with the shortest respawn delay', async () => {
    const { replace, workers, clock } = make(SIGNER)
    for (let attempt = 0; attempt < 5; attempt++) {
      workers[attempt]?.handlers.onMessage({ kind: 'initFailed', error: 'fetch failed' })
      clock.fireNext()
      await killed()
    }
    workers.at(-1)?.handlers.onMessage({ kind: 'initFailed', error: 'fetch failed' })
    expect(clock.nextDueAt()! - clock.now()).toBe(WORKER_RESPAWN_MAX_DELAY_MS)

    await replace()
    expect(clock.pendingCount()).toBe(0)
    workers.at(-1)?.handlers.onExit(1)

    expect(clock.nextDueAt()! - clock.now()).toBe(WORKER_RESPAWN_DELAY_MS)
  })

  it('does not retry a rejected signer', () => {
    const { supervisor, workers, clock } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'signerFailed', error: 'not registered' })
    workers[0]?.handlers.onMessage({ kind: 'initFailed', error: 'not registered' })

    expect(supervisor.getSignerStatus()).toBe('failed')
    expect(clock.pendingCount()).toBe(0)
    expect(workers).toHaveLength(1)
  })

  it('waits for a new key when a worker with a rejected signer exits', async () => {
    const { supervisor, replace, workers, clock } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'signerFailed', error: 'not registered' })
    workers[0]?.handlers.onExit(1)

    expect(supervisor.getSignerStatus()).toBe('failed')
    expect(clock.pendingCount()).toBe(0)
    expect(workers).toHaveLength(1)

    await replace()
    expect(workers).toHaveLength(2)
    expect(supervisor.getSignerStatus()).toBe('starting')
  })

  it('drops the init retry when a new key replaces the signer', async () => {
    const { replace, workers, clock } = make(SIGNER)
    workers[0]?.handlers.onMessage({ kind: 'initFailed', error: 'fetch failed' })

    await replace()

    expect(clock.pendingCount()).toBe(0)
    expect(workers).toHaveLength(2)
    expect(workers[1]?.sent).toEqual([authenticateOf(PENDING_CD, 'cd'), START])
  })

  it('kills the worker on close and starts no other', async () => {
    const { supervisor, workers, clock } = make(SIGNER)
    workers[0]?.handlers.onExit(1)
    clock.fireNext()

    await supervisor.close()

    expect(workers[1]?.killed).toBe(true)
    expect(clock.pendingCount()).toBe(0)
    supervisor.send(START)
    await killed()
    expect(workers).toHaveLength(2)
  })
  describe('pause', () => {
    const running = (id: string) =>
      ({ id, progress: { status: 'running' } }) as unknown as StrategyRecord
    const hydrate = (worker: FakeWorker | undefined, records: StrategyRecord[]) =>
      worker?.handlers.onMessage({ kind: 'strategies', strategies: records, removed: [] })

    it('kills the worker and spawns none until resumed, then one that resumes', async () => {
      const { supervisor, workers, clock } = make(SIGNER)
      workers[0]?.handlers.onMessage({ kind: 'initialised' })

      await supervisor.pause()

      expect(workers[0]?.killed).toBe(true)
      expect(clock.pendingCount()).toBe(0)
      await expect(supervisor.send(START)).resolves.toBe(STRATEGIES_WS_PAUSED_ERROR)
      supervisor.resume()
      expect(workers).toHaveLength(2)
      expect(workers[1]?.sent).toEqual([authenticateOf(SIGNER)])
    })

    it('rejects starts and removes, and drops a tier refresh, while paused', async () => {
      const { supervisor, workers } = make(SIGNER)
      await supervisor.pause()

      await expect(
        supervisor.send({
          kind: 'start',
          id: 's1',
          strategyKind: 'advanced-twap',
          config: {} as never,
          createdAt: 0,
        }),
      ).resolves.toBe(STRATEGIES_WS_PAUSED_ERROR)
      await expect(supervisor.send({ kind: 'remove', id: 's1' })).resolves.toBe(
        STRATEGIES_WS_PAUSED_ERROR,
      )
      await expect(supervisor.send({ kind: 'refreshTier' })).resolves.toBe(true)
      expect(workers[0]?.sent).toEqual([authenticateOf(SIGNER)])
    })

    it('shows a stop at once and sends it to the next worker until it writes the abort', async () => {
      const { supervisor, workers, pendingStops } = make(SIGNER)
      const done = { id: 'done', progress: { status: 'completed' } } as unknown as StrategyRecord
      hydrate(workers[0], [running('s1'), running('s2'), done])
      await supervisor.pause()

      await expect(supervisor.send({ kind: 'stop', id: 's1', reason: 'user' })).resolves.toBe(true)
      await expect(supervisor.send({ kind: 'stop', id: 'done' })).resolves.toBe(true)
      // Persisted by the stopped worker, which was killed before reporting it.
      await expect(supervisor.send({ kind: 'stop', id: 'unreported' })).resolves.toBe(true)

      expect(supervisor.getStrategies().s1?.progress).toMatchObject({
        status: 'aborted',
        reason: 'user',
      })
      expect(supervisor.getStrategies().s2?.progress.status).toBe('running')
      expect(supervisor.getStrategies().done).toBe(done)
      expect([...pendingStops.keys()]).toEqual(['s1', 'unreported'])

      supervisor.resume()
      expect(workers[1]?.sent).toEqual([
        authenticateOf(SIGNER),
        { kind: 'stop', id: 's1', reason: 'user' },
        { kind: 'stop', id: 'unreported', reason: 'Stopped by user' },
      ])
      // The new worker's store still has it running until it handles the stop.
      hydrate(workers[1], [running('s1'), running('s2')])
      expect(supervisor.getStrategies().s1?.progress.status).toBe('aborted')
      expect(pendingStops.size).toBe(1)

      const aborted = { id: 's1', progress: { status: 'aborted', reason: 'user' } }
      hydrate(workers[1], [aborted as unknown as StrategyRecord])
      expect(pendingStops.size).toBe(0)
      expect(supervisor.getStrategies().s1).toBe(aborted)
    })

    it('keeps a stop sent after a restart, before any worker reported its store', async () => {
      const { supervisor, workers, pendingStops } = make(SIGNER, [], { s1: running('s1') })
      expect(supervisor.getStrategies().s1?.progress.status).toBe('running')
      await supervisor.pause()

      await expect(supervisor.send({ kind: 'stop', id: 's1', reason: 'user' })).resolves.toBe(true)

      expect(supervisor.getStrategies().s1?.progress).toMatchObject({
        status: 'aborted',
        reason: 'user',
      })
      expect([...pendingStops.keys()]).toEqual(['s1'])
      supervisor.resume()
      expect(workers[1]?.sent).toEqual([
        authenticateOf(SIGNER),
        { kind: 'stop', id: 's1', reason: 'user' },
      ])
    })

    it('keeps that stop across another restart in the same downtime', async () => {
      const { supervisor, workers, pendingStops } = make(SIGNER, [{ id: 's1', reason: 'user' }], {
        s1: running('s1'),
      })
      expect(supervisor.getStrategies().s1?.progress).toMatchObject({
        status: 'aborted',
        reason: 'user',
      })
      await supervisor.pause()

      await expect(supervisor.send({ kind: 'stop', id: 's1', reason: 'again' })).resolves.toBe(true)
      supervisor.resume()

      expect(workers[1]?.sent).toEqual([
        authenticateOf(SIGNER),
        { kind: 'stop', id: 's1', reason: 'user' },
      ])
      hydrate(workers[1], [{ id: 's1', progress: { status: 'aborted', reason: 'user' } }] as never)
      expect(pendingStops.size).toBe(0)
    })

    it('drops a stop for a record the next worker never loaded', async () => {
      const { supervisor, workers, pendingStops } = make(SIGNER, [{ id: 's1', reason: 'user' }], {
        s1: running('s1'),
        s2: running('s2'),
      })
      expect(supervisor.getStrategies().s1?.progress.status).toBe('aborted')
      expect(workers[0]?.sent).toEqual([
        authenticateOf(SIGNER),
        { kind: 'stop', id: 's1', reason: 'user' },
      ])

      hydrate(workers[0], [running('s2')])
      expect(supervisor.getStrategies().s1).toBeUndefined()
      expect(pendingStops.size).toBe(0)

      await supervisor.pause()
      supervisor.resume()
      expect(workers[1]?.sent).toEqual([authenticateOf(SIGNER)])
    })

    it('started paused, spawns no worker until the first maintenance check resumes it', async () => {
      const { supervisor, workers, pendingStops } = make(SIGNER, [], { s1: running('s1') }, true)
      const start = {
        kind: 'start',
        id: 's2',
        strategyKind: 'advanced-twap',
        config: {} as never,
        createdAt: 0,
      } as const

      expect(workers).toHaveLength(0)
      expect(supervisor.getSignerStatus()).toBe('starting')
      await expect(supervisor.send(start)).resolves.toBe(STRATEGIES_WS_STARTING_ERROR)
      await expect(supervisor.send({ kind: 'stop', id: 's1', reason: 'user' })).resolves.toBe(true)
      expect([...pendingStops.keys()]).toEqual(['s1'])

      supervisor.resume()
      expect(workers).toHaveLength(1)
      expect(workers[0]?.sent).toEqual([
        authenticateOf(SIGNER),
        { kind: 'stop', id: 's1', reason: 'user' },
      ])
    })

    it('started paused, reports the maintenance error once the first check pauses it', async () => {
      const { supervisor, workers } = make(SIGNER, [], {}, true)
      await supervisor.pause()

      await expect(supervisor.send({ kind: 'remove', id: 's1' })).resolves.toBe(
        STRATEGIES_WS_PAUSED_ERROR,
      )
      expect(workers).toHaveLength(0)
      expect(make(null, [], {}, true).supervisor.getSignerStatus()).toBeNull()
    })

    it('sends the stops persisted by a previous server to its first worker', () => {
      const { workers } = make(SIGNER, [{ id: 's1', reason: 'user' }])

      expect(workers[0]?.sent).toEqual([
        authenticateOf(SIGNER),
        { kind: 'stop', id: 's1', reason: 'user' },
      ])
    })
  })
})

describe('endWorkerProcess', () => {
  const child = (exitCode: number | null = null) => {
    let exit = () => {}
    const exited = new Promise<void>((resolve) => {
      exit = resolve
    })
    return {
      process: { exitCode, signalCode: null, kill: vi.fn(() => true), stdin: { end: vi.fn() } },
      exited,
      exit,
    }
  }

  it('ends stdin and does not kill a worker that exits in time', async () => {
    const clock = new FakeClock()
    const { process, exited, exit } = child()
    const ended = endWorkerProcess(process, exited, clock)

    expect(process.stdin.end).toHaveBeenCalledTimes(1)
    exit()
    await ended
    clock.advance(WORKER_EXIT_TIMEOUT_MS)
    clock.fireNext()
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('kills a worker still running after the timeout', () => {
    const clock = new FakeClock()
    const { process, exited } = child()
    void endWorkerProcess(process, exited, clock)

    expect(clock.nextDueAt()).toBe(WORKER_EXIT_TIMEOUT_MS)
    clock.fireNext()
    expect(process.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('leaves a worker that already exited alone', () => {
    const clock = new FakeClock()
    const { process, exited } = child(0)
    void endWorkerProcess(process, exited, clock)

    expect(process.stdin.end).not.toHaveBeenCalled()
    expect(clock.pendingCount()).toBe(0)
  })
})
