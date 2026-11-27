import type { StrategyRecord } from '../engine/types'
import type { MainToWorker, WorkerAuthMessage, WorkerToMain } from '../worker/protocol'
import type { SignedWorkerRegistration, WorkerRegistrationTarget } from './workerRegistration'

/** The worker's `authenticate`, with where to register a new key once its signer is rejected. */
export type ServerWorkerAuthMessage = WorkerAuthMessage & { registration: WorkerRegistrationTarget }

/**
 * Newline-delimited JSON between the server process and the worker process it
 * spawns. The server sends `authenticate` first, then the clients' commands.
 */
export type ServerToWorker = ServerWorkerAuthMessage | MainToWorker

/** The worker's messages, plus the store records that changed since its last one. */
export type WorkerToServer =
  | WorkerToMain
  | { kind: 'strategies'; strategies: StrategyRecord[]; removed: string[] }
  /**
   * The signer itself is unusable (no signer, bad seed, API key not
   * registered, revoked or replaced since init): retrying is pointless.
   * At init it precedes `initFailed`.
   */
  | { kind: 'signerFailed'; error: string }
  /** Sent after `signerFailed`: the key the worker signed a changePubKey for. */
  | { kind: 'registration'; registration: SignedWorkerRegistration }
