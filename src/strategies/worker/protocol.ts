import type {
  ChaseResumeState,
  EngineEvent,
  StrategyConfig,
  StrategyKind,
  StrategyRecord,
  TwapResumeState,
} from '../engine/types'

export interface PriceSnapshot {
  marketId: number
  indexPrice: number | null
  markPrice: number | null
  midPrice: number | null
  bestAskPrice: number | null
  bestBidPrice: number | null
}

export type MainToWorker =
  | {
      kind: 'start'
      id: string
      strategyKind: StrategyKind
      config: StrategyConfig
      /** epoch ms of the strategy record's creation — anchors TWAP schedules. */
      createdAt: number
      resume?: ChaseResumeState | TwapResumeState
      /** A new strategy's record; the worker inserts it into the store. */
      record?: StrategyRecord
    }
  | { kind: 'stop'; id: string; reason?: string }
  /** Drops a finished record; the worker owns the persisted store while alive. */
  | { kind: 'remove'; id: string }
  /** The account's tier changed: reloads it so the next orders carry its integrator fee. */
  | { kind: 'refreshTier' }

/** The main thread's unlocked signer; the worker builds its wasm client from it. */
export interface WorkerSigner {
  seed: string
  accountIndex: number
  apiKeyIndex: number
  chainId: number
}

/**
 * Posted once, straight after spawn and ahead of the buffered messages; a null
 * signer leaves the worker unauthenticated.
 */
export type WorkerAuthMessage = {
  kind: 'authenticate'
  signer: WorkerSigner | null
  /** Pools and the insurance fund are billed as premium, as on main. */
  isPoolAccount: boolean
}

/** Sent once when the worker's wasm + common package init settles. */
export type WorkerInitMessage = { kind: 'initialised' } | { kind: 'initFailed'; error: string }

/** A terminal status carries the record as the worker wrote it: a store read
 *  on main could still precede that write's commit. */
export type WorkerEvent =
  | Exclude<EngineEvent, { type: 'status' }>
  | (Extract<EngineEvent, { type: 'status' }> & { record?: StrategyRecord })

export type WorkerToMain =
  | WorkerInitMessage
  | { kind: 'event'; id: string; event: WorkerEvent }
  /** Nothing left to do: no engine, pending start, order RPC, volume lookup
   *  or store write. The main thread terminates the worker on it. */
  | { kind: 'idle' }

export type WorkerEngineMessage = Exclude<WorkerToMain, WorkerInitMessage>
