import type { ChildProcess } from 'node:child_process'
import { API_KEY_INDEXES } from '../../utils/common'
import type { Clock, StrategyRecord } from '../engine/types'
import type { MainToWorker, WorkerToMain } from '../worker/protocol'
import type { ApiPublicKey } from './backendApiKey'
import type { ServerDb } from './serverDb'
import type { ServerToWorker, ServerWorkerAuthMessage, WorkerToServer } from './serverProtocol'
import type { StrategiesServerRegistration, StrategiesServerSignerStatus } from '../wsProtocol'

export const WORKER_RESPAWN_DELAY_MS = 5000
export const WORKER_RESPAWN_MAX_DELAY_MS = 60_000
/** A worker still running this long after its stdin ended is killed. */
export const WORKER_EXIT_TIMEOUT_MS = 5_000
export const STRATEGIES_WS_PAUSED_ERROR =
  'Lighter is down for maintenance, the strategies resume once it is back'
export const DEFAULT_STRATEGIES_API_KEY_INDEX = API_KEY_INDEXES.STRATEGIES_SERVER
/** A pending seed younger than this is signed for again instead of replaced. */
export const PENDING_SEED_REUSE_MS = 5 * 60_000
/** How often, and for how long after it is signed, Lighter is checked for a registered key. */
export const REGISTRATION_POLL_MS = 5_000
export const REGISTRATION_POLL_MAX_MS = 10 * 60_000
export const STRATEGIES_WS_CLOSING_ERROR = 'The strategies server is shutting down'
export const STRATEGIES_WS_STARTING_ERROR =
  'The strategies server is checking for Lighter maintenance, try again in a few seconds'

type Strategies = Record<string, StrategyRecord>

/**
 * Ends the worker's stdin, on which it flushes its store writes and exits;
 * SIGKILLed if it has not exited after WORKER_EXIT_TIMEOUT_MS.
 */
export const endWorkerProcess = (
  child: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'kill'> & { stdin: { end: () => void } },
  exited: Promise<void>,
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return exited
  child.stdin.end()
  const timer = clock.setTimeout(() => child.kill('SIGKILL'), WORKER_EXIT_TIMEOUT_MS)
  return exited.then(() => clock.clearTimeout(timer))
}

export interface WorkerProcess {
  send: (message: ServerToWorker) => void
  /** Resolves once the process exited. */
  kill: () => Promise<void>
}

export interface WorkerProcessHandlers {
  onMessage: (message: WorkerToServer) => void
  onExit: (code: number | null) => void
}

export interface WorkerSupervisorOptions {
  db: Pick<
    ServerDb,
    | 'readSigner'
    | 'readPendingSigner'
    | 'savePendingSigner'
    | 'adoptPendingSigner'
    | 'readPendingStops'
    | 'savePendingStop'
    | 'deletePendingStop'
  >
  chainId: number
  /** Where the worker registers a new key. */
  apiKeyIndex: number
  isPoolAccount: boolean
  clock: Clock
  /** The records on disk, shown until a worker reports its store. */
  persistedStrategies: Strategies
  /** Spawns no worker until `resume`, as if paused. */
  startPaused?: boolean
  spawnWorker: (handlers: WorkerProcessHandlers) => WorkerProcess
  /** The key Lighter lists at the index; null when it has none. */
  getPublicKey: (accountIndex: number, apiKeyIndex: number) => Promise<ApiPublicKey | null>
  /** The worker's own messages (init, events, idle), for the server's output. */
  onWorkerMessage: (message: WorkerToMain) => void
  onError: (error: unknown) => void
}

export interface WorkerSupervisor {
  /** The account of the stored or pending signer, or the one `register` was called for. */
  getAccountIndex: () => number | null
  /** Null while no worker was started. */
  getSignerStatus: () => StrategiesServerSignerStatus | null
  /** The changePubKey the frontend has to complete, while the signer is failed. */
  getRegistration: () => StrategiesServerRegistration | null
  subscribeRegistration: (
    listener: (registration: StrategiesServerRegistration) => void,
  ) => () => void
  /** Starts a worker with no signer for the account, which registers a key for it. */
  register: (accountIndex: number) => void
  subscribeSignerStatus: (listener: (status: StrategiesServerSignerStatus) => void) => () => void
  getStrategies: () => Strategies
  subscribeStrategies: (listener: (next: Strategies, previous: Strategies) => void) => () => void
  /**
   * Forwards a command to the worker; false while no worker runs. A start
   * while the signer is failed goes to a new worker, which tries the pending
   * signer first, and resolves once the command reached it. While paused, or
   * started paused and not resumed yet, a stop is kept for the next worker,
   * and a start or remove is rejected with the returned error.
   */
  send: (command: MainToWorker) => Promise<boolean | string>
  /** Stops the worker and keeps it stopped, leaving its strategies running in the store. */
  pause: () => Promise<void>
  /** Starts a worker again, which resumes the running strategies. */
  resume: () => void
  close: () => Promise<void>
}

/**
 * Runs the worker process for the signer in the server db. The worker builds
 * its signer once, so a new signer replaces the process; its strategies resume
 * from the persisted store. A worker that exits, or whose init failed on a
 * request (backend down, rate limit), is respawned with the same signer after
 * a growing delay. A rejected signer is not retried: the worker signs a
 * registration for a new key instead, kept as the pending signer. The worker
 * is respawned with it on the next start, or once Lighter lists its key.
 */
export const createWorkerSupervisor = ({
  db,
  chainId,
  apiKeyIndex,
  isPoolAccount,
  clock,
  persistedStrategies,
  startPaused = false,
  spawnWorker,
  getPublicKey,
  onWorkerMessage,
  onError,
}: WorkerSupervisorOptions): WorkerSupervisor => {
  let worker: WorkerProcess | null = null
  let status: StrategiesServerSignerStatus | null = null
  let respawnTimer: number | null = null
  let respawnDelay = WORKER_RESPAWN_DELAY_MS
  let closed = false
  let paused = startPaused
  let pausedError = startPaused ? STRATEGIES_WS_STARTING_ERROR : STRATEGIES_WS_PAUSED_ERROR
  let registration: StrategiesServerRegistration | null = null
  // The account of a first client, before any signer exists.
  let registeringAccount: number | null = null
  let restarting: Promise<void> | null = null
  // The pending seed the poll last restarted the worker for: a worker that rejects it again is not restarted.
  let polledSeed: string | null = null
  let registrationPollTimer: number | null = null
  // Bumped per registration, so an answer for an older one is dropped.
  let registrationPoll = 0
  const registrationListeners = new Set<(registration: StrategiesServerRegistration) => void>()
  // Stops accepted while paused: shown as aborted until the worker writes the abort.
  const pendingStops = new Map(db.readPendingStops().map(({ id, reason }) => [id, reason]))
  const statusListeners = new Set<(status: StrategiesServerSignerStatus) => void>()
  const strategyListeners = new Set<(next: Strategies, previous: Strategies) => void>()

  const setStatus = (next: StrategiesServerSignerStatus) => {
    if (status === next) return
    status = next
    for (const listener of statusListeners) listener(next)
  }

  const withPendingStops = (next: Strategies): Strategies => {
    for (const [id, reason] of pendingStops) {
      const record = next[id]
      if (record?.progress.status !== 'running') continue
      next[id] = { ...record, progress: { ...record.progress, status: 'aborted', reason } }
    }
    return next
  }

  let strategies = withPendingStops({ ...persistedStrategies })

  const settlePendingStop = (id: string) => {
    if (!pendingStops.delete(id)) return
    db.deletePendingStop(id)
  }

  const setStrategies = (next: Strategies) => {
    const previous = strategies
    strategies = next
    for (const listener of strategyListeners) listener(next, previous)
  }

  const stopWorker = async () => {
    if (respawnTimer !== null) clock.clearTimeout(respawnTimer)
    respawnTimer = null
    const stopping = worker
    worker = null
    await stopping?.kill()
  }

  const respawn = () => {
    // One pending respawn at a time: a second timer would kill the worker the first one starts.
    if (respawnTimer !== null) return
    respawnTimer = clock.setTimeout(() => {
      respawnTimer = null
      if (worker) void stopWorker().then(spawn)
      else spawn()
    }, respawnDelay)
    respawnDelay = Math.min(respawnDelay * 2, WORKER_RESPAWN_MAX_DELAY_MS)
  }

  const getAccountIndex = () =>
    db.readSigner()?.accountIndex ?? db.readPendingSigner()?.accountIndex ?? registeringAccount

  // A pending signer goes first: its key may have been registered since.
  const authMessage = (): { message: ServerWorkerAuthMessage; adopting: boolean } | null => {
    const pending = db.readPendingSigner()
    const signer = pending ?? db.readSigner()
    const accountIndex = signer?.accountIndex ?? registeringAccount
    if (accountIndex === null) return null
    const reusedSeed =
      pending && clock.now() - pending.createdAt < PENDING_SEED_REUSE_MS ? pending.seed : null
    return {
      adopting: pending !== null,
      message: {
        kind: 'authenticate',
        signer: signer && {
          seed: signer.seed,
          accountIndex: signer.accountIndex,
          apiKeyIndex: signer.apiKeyIndex,
          chainId,
        },
        isPoolAccount,
        registration: { accountIndex, apiKeyIndex, chainId, seed: reusedSeed },
      },
    }
  }

  const stopRegistrationPoll = () => {
    registrationPoll++
    if (registrationPollTimer !== null) clock.clearTimeout(registrationPollTimer)
    registrationPollTimer = null
  }

  const toKeyHex = (key: string) => key.replace(/^0x/i, '').toLowerCase()

  // The frontend may register the key and never send the start that respawns the worker.
  const pollRegistration = (shown: StrategiesServerRegistration) => {
    stopRegistrationPoll()
    const poll = registrationPoll
    const until = clock.now() + REGISTRATION_POLL_MAX_MS
    const check = async () => {
      registrationPollTimer = null
      const key = await getPublicKey(shown.accountIndex, shown.apiKeyIndex).catch(() => undefined)
      if (poll !== registrationPoll) return
      if (key && toKeyHex(key.publicKey) === toKeyHex(shown.publicKey)) {
        const pendingSeed = db.readPendingSigner()?.seed
        if (status === 'failed' && pendingSeed !== polledSeed) {
          polledSeed = pendingSeed ?? null
          void restart()
        }
        return
      }
      if (clock.now() + REGISTRATION_POLL_MS > until) return
      registrationPollTimer = clock.setTimeout(() => void check(), REGISTRATION_POLL_MS)
    }
    registrationPollTimer = clock.setTimeout(() => void check(), REGISTRATION_POLL_MS)
  }

  const setRegistration = (next: StrategiesServerRegistration | null) => {
    registration = next
    if (!next) {
      stopRegistrationPoll()
      return
    }
    pollRegistration(next)
    for (const listener of registrationListeners) listener(next)
  }

  const spawn = () => {
    if (closed || paused || worker) return
    const auth = authMessage()
    if (!auth) return
    setStatus('starting')
    // That worker adopts the key or signs a new registration, which polls again.
    if (auth.adopting) stopRegistrationPoll()
    let signerRejected = false
    let hydrated = false
    const spawned: WorkerProcess = spawnWorker({
      onMessage: (message) => {
        if (worker !== spawned) return
        if (message.kind === 'strategies') {
          // The first message is the worker's hydrated store; the previous
          // worker's records are shown until then instead of flashing away.
          const next = hydrated ? { ...strategies } : {}
          if (!hydrated) {
            const reported = new Set(message.strategies.map((record) => record.id))
            for (const id of pendingStops.keys()) if (!reported.has(id)) settlePendingStop(id)
          }
          hydrated = true
          for (const id of message.removed) {
            delete next[id]
            settlePendingStop(id)
          }
          for (const record of message.strategies) {
            next[record.id] = record
            if (pendingStops.has(record.id) && record.progress.status !== 'running')
              settlePendingStop(record.id)
          }
          setStrategies(withPendingStops(next))
          return
        }
        if (message.kind === 'signerFailed') {
          signerRejected = true
          setStatus('failed')
          onError(new Error(message.error))
          return
        }
        if (message.kind === 'registration') {
          const { seed, accountIndex, apiKeyIndex: keyIndex, ...shown } = message.registration
          const pending = db.readPendingSigner()
          db.savePendingSigner({
            seed,
            accountIndex,
            apiKeyIndex: keyIndex,
            createdAt: pending?.seed === seed ? pending.createdAt : clock.now(),
          })
          setRegistration({ accountIndex, apiKeyIndex: keyIndex, ...shown })
          return
        }
        if (message.kind === 'initialised') {
          if (auth.adopting) db.adoptPendingSigner()
          registeringAccount = null
          setRegistration(null)
          respawnDelay = WORKER_RESPAWN_DELAY_MS
          setStatus('ready')
        }
        if (message.kind === 'initFailed') {
          setStatus('failed')
          if (!signerRejected) respawn()
        }
        onWorkerMessage(message)
      },
      onExit: (code) => {
        if (worker !== spawned) return
        worker = null
        onError(new Error(`The strategies worker exited with code ${code}`))
        if (signerRejected) return
        setStatus('starting')
        respawn()
      },
    })
    worker = spawned
    spawned.send(auth.message)
    // The worker aborts a resume stopped before it settles, and cancels its orders.
    for (const [id, reason] of pendingStops) spawned.send({ kind: 'stop', id, reason })
  }

  const stopWhilePaused = (id: string, reason: string) => {
    // An unknown id may be a strategy the stopped worker persisted without reporting it.
    const status = strategies[id]?.progress.status
    if ((status !== undefined && status !== 'running') || pendingStops.has(id)) return
    pendingStops.set(id, reason)
    db.savePendingStop({ id, reason })
    setStrategies(withPendingStops({ ...strategies }))
  }

  // A pause or close during the restart leaves no worker: stops are kept for the next one.
  const deliverAfterRestart = (command: MainToWorker): true | string => {
    if (worker) {
      worker.send(command)
      return true
    }
    if (command.kind === 'stop') {
      stopWhilePaused(command.id, command.reason ?? 'Stopped by user')
      return true
    }
    if (command.kind === 'refreshTier') return true
    return closed ? STRATEGIES_WS_CLOSING_ERROR : pausedError
  }

  // Commands sent while the failed worker is replaced go to the new one, in order.
  const restart = () => {
    restarting ??= stopWorker().then(() => {
      restarting = null
      respawnDelay = WORKER_RESPAWN_DELAY_MS
      spawn()
    })
    return restarting
  }

  const restartWith = (command: MainToWorker): Promise<true | string> =>
    restart().then(() => deliverAfterRestart(command))

  if (paused && getAccountIndex() !== null) setStatus('starting')
  spawn()

  return {
    getAccountIndex,
    getSignerStatus: () => status,
    getRegistration: () => registration,
    subscribeRegistration: (listener) => {
      registrationListeners.add(listener)
      return () => registrationListeners.delete(listener)
    },
    register: (accountIndex) => {
      if (closed || getAccountIndex() !== null) return
      registeringAccount = accountIndex
      spawn()
    },
    subscribeSignerStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    getStrategies: () => strategies,
    subscribeStrategies: (listener) => {
      strategyListeners.add(listener)
      return () => strategyListeners.delete(listener)
    },
    send: async (command) => {
      if (paused) {
        if (command.kind === 'stop')
          stopWhilePaused(command.id, command.reason ?? 'Stopped by user')
        if (command.kind === 'start' || command.kind === 'remove') return pausedError
        return true
      }
      if (restarting || (command.kind === 'start' && status === 'failed')) {
        return restartWith(command)
      }
      if (!worker) return false
      worker.send(command)
      return true
    },
    pause: async () => {
      paused = true
      pausedError = STRATEGIES_WS_PAUSED_ERROR
      stopRegistrationPoll()
      await stopWorker()
    },
    resume: () => {
      if (!paused) return
      paused = false
      respawnDelay = WORKER_RESPAWN_DELAY_MS
      spawn()
    },
    close: async () => {
      closed = true
      stopRegistrationPoll()
      await stopWorker()
    },
  }
}
