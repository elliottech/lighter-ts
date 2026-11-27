// Hosts strategy engines off the main thread.
//
// The engine runs here (scheduling, jitter, planning, guardrails). Market data
// comes from the worker's own market-stats websocket (WorkerWebsocket),
// and is cached so the engine's MarketDataSource stays synchronous.
// Market metas are loaded when the first strategy is started.
// The common package is initialised with the worker's own wasm signers when
// the worker module runs; strategies and the websocket wait for the signer
// wasm to load.
// Init then authenticates the worker's wasm client from the signer the main
// thread posts right after spawn, loads that account's tier and the venue fee
// config, and the websocket connects with the account's auth token; without a
// signer the worker stays unauthenticated.
// Orders are placed from the worker's own wasm client. Once no engine, start,
// order RPC, volume lookup or store write is outstanding the worker posts
// `idle`, and the main thread terminates it.
//
// The worker is strategy-agnostic: it looks engines up via createEngine(kind).

import {
  type Clock,
  type StrategyConfig,
  type StrategyEngine,
  type StrategyRecord,
  type TwapResumeState,
  isTwapRecord,
} from '../engine/types'
import type { MainToWorker, WorkerAuthMessage, WorkerToMain } from './protocol'
import { type Order, type WsOrder, selectOrderById, useLighterStore } from '../..'
import { isEqual, omit } from 'lodash-es'
import { WorkerMarketData } from './WorkerMarketData'
import {
  SignerRejectedError,
  assertWorkerAccount,
  authenticateWorker,
  findWorkerSignerKeyError,
  isWorkerRegistered,
} from './workerAuth'
import { captureWorkerException } from './captureWorkerException'
import {
  configureWorkerIdle,
  markWorkerBusy,
  scheduleWorkerIdleCheck,
  trackWorkerTask,
} from './workerIdle'
import { createEngine } from './factories'
import { creditClosingOrderFillDelta, creditOrderTradeVolumesV2 } from './creditOrderTradeVolumesV2'
import { fetchOrderSnapshot } from '../orderSnapshot'
import { formatUnknownError } from '../engine/errors'
import { makeEventListener } from './makeEventListener'
import { useStrategyStore } from '../store/strategyStore'

import { cancelOrderUntilTerminalState } from '../orderLifecycle'
import { makeOrderClient } from './makeOrderClient'
import { assertStrategyNotional } from './strategyNotional'
import { freshStrategyRecord } from './freshStrategyRecord'
import {
  type UnconfirmedOrderSettlement,
  lookupAndSettleUnconfirmedOrders,
  lookupUnconfirmedOrders,
  settleUnconfirmedOrders,
} from './reconcileUnconfirmedOrders'
import type { StrategyWorkerConfig } from './strategyWorkerConfig'
import { WorkerWebsocket, makeIsWorkerPriceFeedLive } from './WorkerWebsocket'
import {
  fetchIsPoolAccount,
  initWorkerAccountFees,
  refreshStrategyUserTier,
} from './workerAccountFees'

type StartMessage = Extract<MainToWorker, { kind: 'start' }>
type StopMessage = Extract<MainToWorker, { kind: 'stop' }>
type RemoveMessage = Extract<MainToWorker, { kind: 'remove' }>

const PRICE_WAIT_TIMEOUT_MS = 30_000
export const TIER_REFRESH_WAIT_MS = 5_000
export const STRATEGY_POOL_ACCOUNT_ERROR = 'Strategies cannot run on a public pool account'

/** A new start (no `resume`) whose id the worker already knows. */
export class DuplicateStrategyIdError extends Error {
  constructor(id: string) {
    super(`A strategy with id ${id} already exists`)
    this.name = 'DuplicateStrategyIdError'
  }
}

const isResumeComplete = (config: StrategyConfig, resume: StartMessage['resume']): boolean =>
  resume !== undefined &&
  resume.filledBaseAmount >=
    config.totalSize - ((resume as Partial<TwapResumeState>).failedBaseAmount ?? 0)

const resumeStartMessage = (record: StrategyRecord): StartMessage => ({
  kind: 'start',
  id: record.id,
  strategyKind: record.kind,
  config: record.config,
  createdAt: record.createdAt,
  resume: {
    filledBaseAmount: record.progress.filledBaseAmount,
    filledQuoteAmount: record.progress.filledQuoteAmount,
    makerBaseAmount: record.progress.makerBaseAmount,
    workingOrders: record.workingOrders,
    ...(isTwapRecord(record)
      ? {
          failedBaseAmount: record.progress.failedBaseAmount,
          consumedSlices: record.progress.consumedSlices,
        }
      : {}),
  },
})

const settled = (promise: Promise<unknown>): Promise<boolean> =>
  promise.then(
    () => true,
    () => false,
  )

// The account orders channel resends a resting order many times a second with
// only these fields bumped. Forwarding those rewrites the persisted store on
// every message.
const RESENT_ORDER_FIELDS = ['transaction_time', 'block_height', 'updated_at', 'timestamp']

const isSameOrderState = (known: Order | undefined, order: WsOrder): boolean =>
  known !== undefined && isEqual(omit(known, RESENT_ORDER_FIELDS), omit(order, RESENT_ORDER_FIELDS))

export class StrategyWorker {
  private readonly clock: Clock
  private readonly post: (message: WorkerToMain) => void
  private readonly strategyWorkerConfig: StrategyWorkerConfig
  private readonly engines = new Map<string, StrategyEngine>()
  private readonly startingIds = new Map<string, AbortController>()
  /** Stop reasons of strategies stopped while their start was still pending. */
  private readonly stoppedBeforeStart = new Map<string, string>()
  private readonly marketData: WorkerMarketData
  private readonly websocket: WorkerWebsocket
  private readonly authenticated: Promise<number>
  private readonly strategyStoreLoaded: Promise<boolean>
  private strategyStoreHydrated = false
  private receiveAuth: (auth: WorkerAuthMessage) => void = () => {}
  private readonly onSignerRejected: ((error: string) => void) | undefined
  private readonly maxStrategyNotional: number | undefined
  private readonly refusePoolAccounts: boolean
  private isPoolAccount = false
  /** Set once the signer's API key was found revoked or replaced after init. */
  private signerError: string | null = null
  private signerCheckPending = false
  private readonly settlement: UnconfirmedOrderSettlement = {
    creditOrderTradeVolumes: creditOrderTradeVolumesV2,
    report: (error, id, orderId) =>
      captureWorkerException(error, {
        id,
        orderId,
        tags: { feature: 'strategy-worker-cancel-before-start' },
      }),
  }

  constructor({
    clock,
    post,
    strategyWorkerConfig,
    signersReady,
    onSignerRejected,
    maxStrategyNotional,
    refusePoolAccounts = false,
  }: {
    clock: Clock
    post: (message: WorkerToMain) => void
    strategyWorkerConfig: StrategyWorkerConfig
    signersReady: Promise<void>
    /**
     * Set to check the signer's API key at init and on `checkSignerKey`.
     * Called before `initFailed` when the signer itself is rejected (as
     * opposed to a failed request), and once if the key was revoked or
     * replaced since init, after every strategy was aborted.
     */
    onSignerRejected?: (error: string) => void
    /** New strategies estimated to trade more quote than this are aborted. */
    maxStrategyNotional?: number
    /** Set to abort new strategies of a pool account, whether `authenticate` or the backend says it is one. */
    refusePoolAccounts?: boolean
  }) {
    this.clock = clock
    this.post = post
    this.strategyWorkerConfig = strategyWorkerConfig
    this.onSignerRejected = onSignerRejected
    this.maxStrategyNotional = maxStrategyNotional
    this.refusePoolAccounts = refusePoolAccounts

    const authReceived = new Promise<WorkerAuthMessage>((resolve) => {
      this.receiveAuth = resolve
    })
    this.authenticated = signersReady
      .then(() => authReceived)
      .then(async (auth) => {
        const accountIndex = await authenticateWorker(auth.signer, {
          verifyKey: onSignerRejected !== undefined,
        })
        this.isPoolAccount =
          auth.isPoolAccount || (refusePoolAccounts && (await fetchIsPoolAccount(accountIndex)))
        await initWorkerAccountFees(accountIndex, this.isPoolAccount)
        return accountIndex
      })
    // The main thread reports init failures (once per distinct error); the
    // worker is replaced on each one, so it has no session memory to dedupe
    // them with.
    this.authenticated.then(
      () => {
        post({ kind: 'initialised' })
        // Every start queued for this worker may have been dropped by a stop
        // before init; with nothing to run, idle is still reported.
        scheduleWorkerIdleCheck()
      },
      (error: unknown) => {
        const message = formatUnknownError(error)
        if (error instanceof SignerRejectedError) onSignerRejected?.(message)
        post({ kind: 'initFailed', error: message })
      },
    )

    this.marketData = new WorkerMarketData(clock, makeIsWorkerPriceFeedLive(strategyWorkerConfig))
    configureWorkerIdle({
      isBusy: this.hasWork,
      onIdle: () => post({ kind: 'idle' }),
    })
    // The worker writes the whole persisted store, so nothing may be written
    // before it has loaded the records other contexts saved.
    this.strategyStoreLoaded = Promise.resolve(useStrategyStore.persist.rehydrate()).then(() => {
      this.strategyStoreHydrated = useStrategyStore.persist.hasHydrated()
      return this.strategyStoreHydrated
    })
    this.websocket = new WorkerWebsocket(
      this.marketData,
      clock,
      this.hasWork,
      this.authenticated,
      (order: WsOrder) => {
        for (const engine of this.engines.values()) {
          if (isSameOrderState(engine.getWorkingOrders()[order.order_id], order)) continue
          engine.onFillUpdate({ restingOrder: order })
        }
      },
      () => this.engines,
      this.strategyWorkerConfig,
      this.checkSignerKey,
    )
    this.websocket.start()
  }

  /** Called when the websocket fails to open or a request is rejected. */
  readonly checkSignerKey = (): void => {
    const onSignerRejected = this.onSignerRejected
    if (!onSignerRejected || this.signerError !== null || this.signerCheckPending) return
    this.signerCheckPending = true
    findWorkerSignerKeyError()
      .then(
        (error) => {
          if (error === null) return
          this.signerError = error
          for (const controller of this.startingIds.values()) controller.abort(new Error(error))
          for (const engine of this.engines.values()) engine.stop(error)
          onSignerRejected(error)
        },
        // Unreachable REST is not a revoked key; the next failure checks again.
        () => {},
      )
      .finally(() => {
        this.signerCheckPending = false
      })
  }

  authenticate(auth: WorkerAuthMessage): void {
    this.receiveAuth(auth)
  }

  /** A start without `resume` is new: one whose id is known is reported and changes nothing.
   *  Its record is built here, and stored once its checks pass, or as aborted when they fail. */
  async start(msg: StartMessage): Promise<void> {
    if (this.engines.has(msg.id) || this.startingIds.has(msg.id)) {
      if (!msg.resume) this.refuseDuplicateStart(msg.id)
      return
    }
    markWorkerBusy()
    try {
      await this.createAndStartEngine(msg)
    } finally {
      scheduleWorkerIdleCheck()
    }
  }

  /** Restarts every persisted `running` record with the same resume state
   *  `StrategyManager` sends. */
  async resumeRunningStrategies(): Promise<void> {
    if (!(await this.strategyStoreLoaded)) return
    const records = Object.values(useStrategyStore.getState().strategies).filter(
      (record) => record.progress.status === 'running',
    )
    await Promise.all(records.map((record) => this.start(resumeStartMessage(record))))
  }

  stop(msg: StopMessage): void {
    const reason = msg.reason ?? 'Stopped by user'
    if (this.startingIds.has(msg.id)) {
      this.startingIds.get(msg.id)?.abort()
      this.startingIds.delete(msg.id)
      this.stoppedBeforeStart.set(msg.id, reason)
      // Written as soon as the records are loaded, before the start settles.
      void this.strategyStoreLoaded.then(() => this.abortStart(msg.id, reason))
      return
    }
    const engine = this.engines.get(msg.id)
    if (engine) {
      engine.stop(msg.reason)
      return
    }
    // No engine (its start failed, or it already ended): write the abort
    // directly, never over a completed record, and cancel whatever the
    // record still holds, as no engine will. Tracked so the idle check
    // cannot report idle (and main terminate the worker) mid-cancel.
    void trackWorkerTask(
      this.strategyStoreLoaded.then(async () => {
        // A resume may have started while the records were loading.
        if (this.startingIds.has(msg.id) || this.engines.has(msg.id)) {
          this.stop(msg)
          return
        }
        const record = useStrategyStore.getState().strategies[msg.id]
        if (record?.progress.status !== 'running') return
        this.abortStart(msg.id, reason)
        await this.cancelPersistedOrders(msg.id, record.config.accountIndex, record.workingOrders)
      }),
    )
  }

  refreshTier(): Promise<void> {
    return refreshStrategyUserTier()
  }

  remove(msg: RemoveMessage): void {
    // Reported idle again once the write is flushed: main may have posted
    // this after an earlier idle and is waiting for it. Removed only once the
    // records are loaded, or the load restores the record.
    void trackWorkerTask(
      this.strategyStoreLoaded.then((loaded) => {
        if (!loaded) return
        if (!this.engines.has(msg.id) && !this.startingIds.has(msg.id))
          useStrategyStore.getState().remove(msg.id)
      }),
    )
  }

  private readonly hasWork = (): boolean => this.engines.size > 0 || this.startingIds.size > 0

  /** Aborts a strategy that never got an engine; main gets the same status
   *  event an engine would emit. */
  /** `unstored` is a new start's record, written as aborted in the same store write. */
  private abortStart(id: string, reason: string, unstored?: StrategyRecord): void {
    // Any store action persists the whole store, even when it changes nothing.
    if (this.strategyStoreHydrated) {
      const state = useStrategyStore.getState()
      if (unstored) {
        state.upsert({ ...unstored, progress: { ...unstored.progress, status: 'aborted', reason } })
      } else state.patchProgress(id, { status: 'aborted', reason })
    }
    this.post({
      kind: 'event',
      id,
      event: {
        type: 'status',
        status: 'aborted',
        reason,
        record: useStrategyStore.getState().strategies[id],
      },
    })
  }

  /** Marks a resumed strategy whose persisted fills already cover its size. */
  private completeStart(id: string): void {
    useStrategyStore.getState().patchProgress(id, { status: 'completed' })
    this.post({
      kind: 'event',
      id,
      event: {
        type: 'status',
        status: 'completed',
        record: useStrategyStore.getState().strategies[id],
      },
    })
  }

  /**
   * A strategy aborted without an engine (stopped or failed before its start
   * settled) still owns the working orders it was persisted with; nothing else
   * would cancel them.
   */
  private async cancelPersistedOrders(
    id: string,
    accountIndex: number,
    workingOrders: Record<string, Order>,
  ): Promise<void> {
    if (!(await settled(this.authenticated)) || !isWorkerRegistered(accountIndex)) return
    for (const baseline of Object.values(workingOrders)) {
      try {
        const order = await cancelOrderUntilTerminalState({
          accountIndex,
          marketId: baseline.market_index,
          orderId: baseline.order_id,
          clientOrderIndex: baseline.client_order_index,
        })
        creditClosingOrderFillDelta(id, baseline, order)
        creditOrderTradeVolumesV2(id, order)
      } catch (error) {
        captureWorkerException(error, {
          id,
          orderId: baseline.order_id,
          tags: { feature: 'strategy-worker-cancel-before-start' },
        })
      }
    }
    // Last: an in-flight order is waited for until its tx can no longer land.
    await lookupAndSettleUnconfirmedOrders(id, accountIndex, this.settlement)
  }

  private cancelResumedOrders(msg: StartMessage): Promise<void> {
    return msg.resume?.workingOrders
      ? trackWorkerTask(
          this.cancelPersistedOrders(msg.id, msg.config.accountIndex, msg.resume.workingOrders),
        )
      : Promise.resolve()
  }

  private async ensureMarket(id: string, marketId: number): Promise<void> {
    if (this.marketData.hasMarket(marketId)) return
    try {
      await this.marketData.initializeMarketMetas()
    } catch (error) {
      captureWorkerException(error, {
        id,
        tags: { feature: 'strategy-worker-market-metas' },
      })
      throw new Error(`Failed to load market metas: ${formatUnknownError(error)}`)
    }
    if (!this.marketData.hasMarket(marketId)) {
      throw new Error(`Unknown market ${marketId}`)
    }
  }

  private async ensurePrice(marketId: number, controller: AbortController): Promise<void> {
    if (this.marketData.hasPrice(marketId)) return
    const timeout = this.clock.setTimeout(
      () => controller.abort(new Error(`Timed out waiting for market ${marketId} price`)),
      PRICE_WAIT_TIMEOUT_MS,
    )
    try {
      await this.marketData.waitForPrice(marketId, controller.signal)
    } finally {
      this.clock.clearTimeout(timeout)
    }
  }

  // Waits up to TIER_REFRESH_WAIT_MS, then starts on the last tier anyway; the
  // request is not cancelled, so the tier is still updated when it eventually answers.
  private async waitForTierRefresh(tierRefreshed: Promise<void>): Promise<void> {
    let release = () => {}
    const timeout = this.clock.setTimeout(() => release(), TIER_REFRESH_WAIT_MS)
    try {
      await Promise.race([
        tierRefreshed,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      ])
    } finally {
      this.clock.clearTimeout(timeout)
    }
  }

  private resetCreatedAt(id: string): number {
    const createdAt = this.clock.now()
    const state = useStrategyStore.getState()
    const record = state.strategies[id]
    if (record) state.upsert({ ...record, createdAt })
    return createdAt
  }

  private refuseDuplicateStart(id: string): void {
    captureWorkerException(new DuplicateStrategyIdError(id), {
      id,
      tags: { feature: 'strategy-worker-start' },
    })
  }

  private async createAndStartEngine(msg: StartMessage): Promise<void> {
    const { marketId } = msg.config
    const controller = new AbortController()
    this.startingIds.set(msg.id, controller)
    let startError: string | null = null
    let alreadyComplete = false
    let pendingRecord: StrategyRecord | undefined
    try {
      if (!(await this.strategyStoreLoaded)) {
        throw new Error('Failed to load the strategy store')
      }
      if (!msg.resume) {
        if (useStrategyStore.getState().strategies[msg.id]) {
          this.stoppedBeforeStart.delete(msg.id)
          this.refuseDuplicateStart(msg.id)
          return
        }
        // A stored running record is resumed after a restart without these checks.
        pendingRecord = freshStrategyRecord(msg)
      } else if (msg.record) useStrategyStore.getState().upsert(msg.record)
      alreadyComplete = isResumeComplete(msg.config, msg.resume)
      if (!alreadyComplete) {
        const initError = await this.authenticated.then(
          () => null,
          (error: unknown) => error,
        )
        if (initError !== null) {
          // Resumes wait for the retried worker unless the signer itself is unusable.
          if (msg.resume && !(initError instanceof SignerRejectedError)) return
          throw new Error(formatUnknownError(initError))
        }
        if (this.signerError !== null) throw new Error(this.signerError)
        assertWorkerAccount(msg.config.accountIndex)
        if (!msg.resume && this.refusePoolAccounts && this.isPoolAccount) {
          throw new Error(STRATEGY_POOL_ACCOUNT_ERROR)
        }
        controller.signal.throwIfAborted()
        const tierRefreshed = msg.resume ? Promise.resolve() : refreshStrategyUserTier()
        await this.ensureMarket(msg.id, marketId)
        controller.signal.throwIfAborted()
        this.websocket.connect()
        await this.ensurePrice(marketId, controller)
        if (!msg.resume && this.maxStrategyNotional !== undefined) {
          assertStrategyNotional(
            msg.strategyKind,
            msg.config,
            this.marketData,
            this.maxStrategyNotional,
          )
        }
        await this.waitForTierRefresh(tierRefreshed)
        controller.signal.throwIfAborted()
      }
    } catch (error) {
      startError = formatUnknownError(error)
    } finally {
      this.startingIds.delete(msg.id)
    }
    const stopReason = this.stoppedBeforeStart.get(msg.id)
    // Stored running only once the checks passed; a failed one is stored aborted in one write.
    if (pendingRecord && stopReason === undefined && startError === null) {
      useStrategyStore.getState().upsert(pendingRecord)
    }

    if (stopReason !== undefined) {
      this.stoppedBeforeStart.delete(msg.id)
      // The record may have been inserted after the stop was handled.
      this.abortStart(msg.id, stopReason, pendingRecord)
      await this.cancelResumedOrders(msg)
      return
    }

    if (startError !== null) {
      this.abortStart(msg.id, startError, pendingRecord)
      await this.cancelResumedOrders(msg)
      return
    }
    if (alreadyComplete) {
      this.completeStart(msg.id)
      return
    }
    // Main's stamp predates the worker's startup; a resume's schedule is
    // regenerated from its stamp, so it keeps it.
    const createdAt = msg.resume ? msg.createdAt : this.resetCreatedAt(msg.id)
    const engine = createEngine(
      msg.strategyKind,
      msg.config,
      {
        marketData: this.marketData,
        orderClient: makeOrderClient(msg.id, () => this.engines, this.marketData),
        clock: this.clock,
        createdAt,
      },
      makeEventListener(msg.id, () => this.engines, this.post),
      msg.resume,
    )
    if (engine.getProgress().status !== 'running') {
      // Aborted in its constructor: the record's orders are nobody's now.
      await this.cancelResumedOrders(msg)
      return
    }
    this.engines.set(msg.id, engine)
    const resumedOrders = msg.resume?.workingOrders
    if (resumedOrders) {
      try {
        // Orders in flight when the previous worker was lost are settled
        // first: the engine credits their fills and keeps a resting one as a
        // working order, which `start()` then handles like any resumed order.
        // One that may still land is waited for, so the engine cannot resend
        // its size. Tracked so the idle check cannot retire the worker
        // mid-wait.
        const unconfirmed = await trackWorkerTask(
          lookupUnconfirmedOrders(msg.id, msg.config.accountIndex),
        )
        for (const [index, { order, isMaker }] of unconfirmed.orders.entries()) {
          if (engine.getProgress().status !== 'running') {
            // Stopped while waiting, or ended by an earlier adoption: the
            // engine no longer adopts anything, so the rest are settled as a
            // stop before start would.
            await trackWorkerTask(
              settleUnconfirmedOrders(
                msg.id,
                msg.config.accountIndex,
                unconfirmed.orders.slice(index),
                this.settlement,
              ),
            )
            return
          }
          engine.adoptOrder(order, isMaker)
        }
        if (engine.getProgress().status !== 'running') return
        // The adopted orders are the engine's now, so its abort cancels them.
        if (unconfirmed.error !== undefined) throw unconfirmed.error
        const lighterStoreState = useLighterStore.getState()
        for (const orderId in resumedOrders) {
          const order = resumedOrders[orderId]
          if (!order) continue
          const latestStateOfOrder =
            selectOrderById(lighterStoreState, {
              accountIndex: msg.config.accountIndex,
              marketId: order.market_index,
              orderId,
            }) ??
            (await fetchOrderSnapshot({
              accountIndex: msg.config.accountIndex,
              clientOrderIndex: order.client_order_index,
            }))
          if (!latestStateOfOrder) throw new Error(`Order ${orderId} not found`)
          engine.onFillUpdate({ restingOrder: latestStateOfOrder })
        }
      } catch {
        // Aborting through the engine cancels the persisted working order and
        // reports the status like any other abort.
        engine.stop('Failed to resume order')
        return
      }
    }
    // A stop that arrived during the reconciliation above already aborted it.
    if (engine.getProgress().status !== 'running') return
    engine.start()
  }
}
