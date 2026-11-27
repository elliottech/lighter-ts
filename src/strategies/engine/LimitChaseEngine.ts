// Limit-chase runtime. Keeps one resting limit order at the own-side top of
// book (buy=best bid, sell=best ask), modifying that same venue order as the
// quote moves. Fills are counted from ws-confirmed orders only: deltas from
// the streamed working-order updates plus the orders returned by
// submit/modify/cancel.

import {
  CHASE_DEFAULT_START_STATE,
  type ChaseLimitProgress,
  type ChaseResumeState,
  type Clock,
  ENGINE_ORDER_TYPE,
  ENGINE_TIF,
  type EngineEvent,
  type EngineEventListener,
  type FillUpdate,
  type LimitChaseConfig,
  type MarketDataSource,
  type MarketMeta,
  type OrderClient,
  RESTING_STATUSES,
  type StrategyEngine,
  type StrategyStatus,
  type SubmitOrderInput,
} from './types'
import {
  ORDER_OP_TRACK_EVENTS,
  StrategyEngineTrackEvents,
  type StrategyOrderOp,
} from '../trackEvents'
import {
  type Order,
  StrategyOrderKind,
  ceilNumber,
  computeWorstExecutionPrice,
  convertFloatToBase,
  floorNumber,
  roundNumber,
} from '../..'
import { PER_SLICE_SLIPPAGE_PCT } from '../presets'
import {
  REDUCE_ONLY_EXHAUSTED_REASON,
  formatUnknownError,
  isNonRetryableOrderError,
} from './errors'
import { capAtBound, getIndexBoundPrice, getMinSliceSize } from './planner'
import { OrderStatusEnum } from 'zklighter-perps'

// A resting chase order in one of these terminal states is replaced with a
// fresh order. 'canceled-expired' is included because the working order reprices
// in place via modify, which never refreshes the order expiry — so a long-lived
// chase eventually expires and must be re-placed (otherwise it stalls, retrying
// to cancel a dead order). Safe against double-submit because fill updates are
// skipped while a modify/cancel result is in flight and the chase() catch is
// ownership-checked.
const RESUBMITTABLE_TERMINAL_STATUSES = new Set([
  'canceled',
  'canceled-post-only',
  'canceled-self-trade',
  'canceled-expired',
])

const LIMIT_CHASE_ORDER_EXPIRY_MS = 60 * 60 * 1000

interface LimitChaseDeps {
  marketData: MarketDataSource
  orderClient: OrderClient
  clock: Clock
}

export class LimitChaseEngine implements StrategyEngine {
  private readonly config: LimitChaseConfig
  private readonly deps: LimitChaseDeps
  private readonly listeners = new Set<EngineEventListener>()

  private market: MarketMeta = null!
  private timer: number | null = null
  private status: StrategyStatus = 'running'
  private totalBaseAmount = 0
  private filledBaseAmount = 0
  private filledQuoteAmount = 0
  private makerBaseAmount = 0
  private nextActionAt: number | null = null
  private currentOrder: Order | null = null
  /** Set while a modify/cancel awaits its ws-confirmed result. That result
   *  owns the fill accounting for the order, so streamed fill updates must
   *  not credit (or clear the baseline) in the meantime. */
  private resultInFlight = false
  private resumed = false
  /** Fill updates replayed before `start()` only credit; the first `chase()`
   *  decides what to submit, so a dead working order is not replaced twice. */
  private started = false

  constructor(
    config: LimitChaseConfig,
    deps: LimitChaseDeps,
    listener: EngineEventListener,
    resume?: ChaseResumeState,
  ) {
    this.config = config
    this.deps = deps
    this.on(listener)
    const { workingOrders, filledBaseAmount, filledQuoteAmount, makerBaseAmount } =
      resume ?? CHASE_DEFAULT_START_STATE
    this.totalBaseAmount = this.config.totalSize
    this.filledBaseAmount = filledBaseAmount
    this.filledQuoteAmount = filledQuoteAmount
    this.makerBaseAmount = makerBaseAmount
    this.resumed = !!resume
    const market = this.deps.marketData.getMarket(this.config.marketId)
    const resumedOrders = Object.values(workingOrders)

    if (resumedOrders.length > 1) {
      this.abort(`Too many working orders`)
      return
    }

    if (!market) {
      this.abort(`Market ${this.config.marketId} not found`)
      return
    }

    this.market = market

    const resumedOrder = resumedOrders[0]
    if (resumedOrder && RESTING_STATUSES.has(resumedOrder.status)) {
      this.currentOrder = resumedOrder
    }
    this.status = 'running'
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getProgress(): ChaseLimitProgress {
    return {
      status: this.status,
      totalBaseAmount: this.totalBaseAmount,
      filledBaseAmount: this.filledBaseAmount,
      filledQuoteAmount: this.filledQuoteAmount,
      makerBaseAmount: this.makerBaseAmount,
      nextActionAt: this.status === 'running' ? this.nextActionAt : null,
    }
  }

  start(): void {
    if (this.status !== 'running') throw new Error('engine aborted before start')
    if (this.started) throw new Error('engine already started')
    this.started = true
    this.emit({ type: 'status', status: 'running' })
    this.emitTrack(StrategyEngineTrackEvents.STARTED, {
      marketId: this.config.marketId,
      side: this.config.isAsk === 1 ? 'sell' : 'buy',
      totalBase: this.totalBaseAmount,
      filledBase: this.filledBaseAmount,
      resumed: this.resumed,
    })
    this.chase()
  }

  stop(reason = 'Stopped by user'): void {
    this.abort(reason)
  }

  onFillUpdate(update: FillUpdate): void {
    if (
      this.status !== 'running' ||
      this.resultInFlight ||
      !this.currentOrder ||
      update.restingOrder.order_id !== this.currentOrder.order_id
    ) {
      return
    }

    this.creditFill(update.restingOrder, this.currentOrder, true)

    if (this.started && this.shouldResubmitAfter(update.restingOrder)) {
      this.clearTimeout()
      void this.submitRemaining()
    }
  }

  adoptOrder(order: Order, isMaker: boolean): void {
    if (this.status !== 'running') return
    this.creditFill(order, null, isMaker)
  }

  private shouldResubmitAfter(order: Order): boolean {
    return (
      RESUBMITTABLE_TERMINAL_STATUSES.has(order.status) || order.status === OrderStatusEnum.Filled
    )
  }

  private getTargetRestingSize(chasePrice: number): number {
    const remaining = roundNumber(
      this.totalBaseAmount - this.filledBaseAmount,
      this.market.size_decimals,
    )

    const chunk = Math.max(
      roundNumber(this.config.restingChunkBaseAmount, this.market.size_decimals),
      getMinSliceSize(this.market, chasePrice),
    )

    return Math.min(chunk, remaining)
  }

  // ---- internals --------------------------------------------------------

  /** Places a working order for the remaining size (the initial submit is
   *  just the case where nothing has filled yet). */
  private async submitRemaining(): Promise<void> {
    if (this.status !== 'running') {
      return
    }

    if (this.filledBaseAmount >= this.totalBaseAmount) {
      this.complete()
      return
    }

    const chasePrice = this.getCurrentChasePrice()

    if (chasePrice === null) {
      this.scheduleNext()
      return
    }

    if (this.totalBaseAmount - this.filledBaseAmount < getMinSliceSize(this.market, chasePrice)) {
      await this.submitFinalMarketOrder()
      return
    }

    try {
      await this.submitWorkingOrder(chasePrice, this.getTargetRestingSize(chasePrice))
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'limit-chase',
          function: 'submitRemaining',
        },
      })
      this.abortIfNonRetryable(error)
      this.scheduleNext()
    }
  }

  private scheduleNext() {
    if (this.status !== 'running') {
      return
    }

    this.nextActionAt = this.deps.clock.now() + this.config.repriceIntervalMs
    this.emitProgress()
    this.timer = this.deps.clock.setTimeout(() => {
      void this.chase()
    }, this.config.repriceIntervalMs)
  }

  private async chase(): Promise<void> {
    if (this.status !== 'running') {
      return
    }
    if (this.currentOrder === null) {
      await this.submitRemaining()
      return
    }

    const chasePrice = this.getCurrentChasePrice()

    if (chasePrice === null) {
      this.scheduleNext()
      return
    }

    if (chasePrice === this.currentOrder.price) {
      this.scheduleNext()
      return
    }

    this.resultInFlight = true
    try {
      const { order } = await this.trackOp(
        'modify',
        { orderId: this.currentOrder.order_id },
        this.deps.orderClient.modifyOrder({
          accountIndex: this.config.accountIndex,
          marketId: this.market.market_id,
          orderId: this.currentOrder.order_id,
          clientOrderIndex: this.currentOrder.client_order_index,
          baseAmount: convertFloatToBase(
            this.currentOrder.initial_base_amount,
            this.market.size_decimals,
          ),
          price: Math.max(1, convertFloatToBase(chasePrice, this.market.price_decimals)),
          triggerPrice: 0,
          isAsk: this.config.isAsk,
        }),
      )

      if (this.status !== 'running') {
        return
      }

      this.creditFill(order, this.currentOrder, true)
      this.resultInFlight = false

      if (this.shouldResubmitAfter(order)) {
        await this.submitRemaining()
        return
      }
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'limit-chase',
          function: 'chase',
        },
      })
      this.abortIfNonRetryable(error)
    } finally {
      this.resultInFlight = false
    }

    this.scheduleNext()
  }

  private getCurrentChasePrice(): number | null {
    return this.computeBoundedPrice(
      this.config.isAsk === 1
        ? this.deps.marketData.getBestAskPrice(this.market.market_id)
        : this.deps.marketData.getBestBidPrice(this.market.market_id),
      this.config.maxDistancePercent,
      this.config.isAsk !== 1,
    )
  }

  private computeBoundedPrice(
    referencePrice: number | null,
    percent: number,
    isShort: boolean,
  ): number | null {
    if (referencePrice === null) {
      return null
    }

    const indexPrice = this.deps.marketData.getIndexPrice(this.market.market_id)
    if (!indexPrice) {
      return null
    }

    const { isAsk, maxIndexPriceDistancePercent } = this.config
    const round = isAsk === 1 ? ceilNumber : floorNumber

    let bounded = capAtBound(
      computeWorstExecutionPrice(percent, isShort, referencePrice),
      getIndexBoundPrice(indexPrice, PER_SLICE_SLIPPAGE_PCT, isAsk),
      isAsk,
    )

    if (maxIndexPriceDistancePercent !== undefined) {
      bounded = capAtBound(
        bounded,
        getIndexBoundPrice(indexPrice, maxIndexPriceDistancePercent, isAsk),
        isAsk,
      )
    }

    return round(bounded, this.market.price_decimals)
  }

  private buildOrderInput(humanPrice: number, baseAmount: number): SubmitOrderInput {
    return {
      accountIndex: this.config.accountIndex,
      orderBookIndex: this.market.market_id,
      baseAmount: convertFloatToBase(baseAmount, this.market.size_decimals),
      price: Math.max(1, convertFloatToBase(humanPrice, this.market.price_decimals)),
      isAsk: this.config.isAsk,
      orderType: ENGINE_ORDER_TYPE.limit,
      timeInForce: ENGINE_TIF.postOnly,
      reduceOnly: this.config.reduceOnly ? 1 : 0,
      triggerPrice: 0,
      orderExpiry: this.deps.clock.now() + LIMIT_CHASE_ORDER_EXPIRY_MS,
      strategyOrderKind: StrategyOrderKind.ChaseLimit,
    }
  }

  private async submitWorkingOrder(humanPrice: number, baseAmount: number): Promise<void> {
    if (this.status !== 'running') {
      return
    }

    const { order } = await this.trackOp(
      'submit',
      { orderType: 'limit' },
      this.deps.orderClient.submitOrder(this.buildOrderInput(humanPrice, baseAmount)),
    )

    this.creditFill(order, null, true)

    // Aborted while the submit was in flight: don't adopt the order — release
    // it (abort's own cancel ran before this order existed).
    if (this.status !== 'running' && RESTING_STATUSES.has(order.status)) {
      await this.cancelWorkingOrder(order)
    }

    this.scheduleNext()
  }

  private async submitFinalMarketOrder(): Promise<void> {
    const remaining = roundNumber(
      this.totalBaseAmount - this.filledBaseAmount,
      this.market.size_decimals,
    )
    const bound = this.computeBoundedPrice(
      this.config.isAsk === 1
        ? this.deps.marketData.getBestBidPrice(this.market.market_id)
        : this.deps.marketData.getBestAskPrice(this.market.market_id),
      PER_SLICE_SLIPPAGE_PCT,
      this.config.isAsk === 1,
    )

    if (bound === null) {
      this.complete()
      return
    }

    try {
      const { order } = await this.trackOp(
        'submit',
        { orderType: 'market' },
        this.deps.orderClient.submitOrder({
          accountIndex: this.config.accountIndex,
          orderBookIndex: this.market.market_id,
          baseAmount: convertFloatToBase(remaining, this.market.size_decimals),
          price: Math.max(1, convertFloatToBase(bound, this.market.price_decimals)),
          isAsk: this.config.isAsk,
          orderType: ENGINE_ORDER_TYPE.market,
          timeInForce: ENGINE_TIF.immediateOrCancel,
          reduceOnly: this.config.reduceOnly ? 1 : 0,
          triggerPrice: 0,
          orderExpiry: 0,
          strategyOrderKind: StrategyOrderKind.ChaseLimit,
        }),
      )

      this.creditFill(order, null)
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'limit-chase',
          function: 'submitFinalMarketOrder',
        },
      })
      this.abortIfNonRetryable(error)
    }

    this.complete()
  }

  private complete(): void {
    if (this.status !== 'running') {
      return
    }

    this.clearTimeout()
    this.status = 'completed'
    this.emitTrack(StrategyEngineTrackEvents.COMPLETED, {
      filledBase: this.filledBaseAmount,
      totalBase: this.totalBaseAmount,
    })
    this.emitProgress()
    this.emit({ type: 'status', status: 'completed' })
  }

  private abort(reason: string): void {
    if (this.status !== 'running') {
      return
    }

    this.clearTimeout()
    this.status = 'aborted'
    this.emitTrack(StrategyEngineTrackEvents.ABORTED, {
      reason,
      filledBase: this.filledBaseAmount,
      totalBase: this.totalBaseAmount,
    })
    void this.cancelWorkingOrder()
    this.emitProgress()
    this.emit({ type: 'status', status: 'aborted', reason })
  }

  private abortIfNonRetryable(error: unknown): void {
    if (isNonRetryableOrderError(error)) {
      this.abort(formatUnknownError(error))
    }
  }

  /**
   * Cancels the given working order (defaults to the tracked one). Credits the
   * ws-confirmed final fills beyond the passed snapshot.
   */
  private async cancelWorkingOrder(workingOrder: Order | null = this.currentOrder) {
    if (!workingOrder) {
      return
    }

    this.resultInFlight = true
    try {
      const { order } = await this.trackOp(
        'cancel',
        { orderId: workingOrder.order_id },
        this.deps.orderClient.cancelOrder({
          accountIndex: this.config.accountIndex,
          marketId: this.market.market_id,
          orderId: workingOrder.order_id,
          clientOrderIndex: workingOrder.client_order_index,
        }),
      )

      this.creditFill(order, workingOrder, true)
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'limit-chase',
          function: 'cancelWorkingOrder',
        },
      })
    }

    this.resultInFlight = false
  }

  private isReduceOnlyExhausted(order: Order): boolean {
    return this.config.reduceOnly && order.status === OrderStatusEnum.CanceledReduceOnly
  }

  /** Credit a ws order's fills beyond the already-counted baseline snapshot. */
  private creditFill(order: Order, baseline: Order | null, isMaker = false): void {
    const baseDelta = order.filled_base_amount - (baseline?.filled_base_amount ?? 0)
    this.filledBaseAmount = roundNumber(
      this.filledBaseAmount + baseDelta,
      this.market.size_decimals,
    )
    this.filledQuoteAmount += order.filled_quote_amount - (baseline?.filled_quote_amount ?? 0)

    if (isMaker) {
      this.makerBaseAmount = roundNumber(
        this.makerBaseAmount + baseDelta,
        this.market.size_decimals,
      )
    }

    if (RESTING_STATUSES.has(order.status)) {
      this.currentOrder = order
      this.emit({ type: 'updateWorkingOrder', order })
    } else {
      if (this.currentOrder?.order_id === order.order_id) {
        this.currentOrder = null
      }
      this.emit({
        type: 'removeWorkingOrder',
        order,
      })
    }

    this.emitProgress()

    if (this.filledBaseAmount >= this.totalBaseAmount) {
      this.complete()
    } else if (this.isReduceOnlyExhausted(order)) {
      this.abort(REDUCE_ONLY_EXHAUSTED_REASON)
    }
  }

  private emitProgress(): void {
    this.emit({ type: 'progress', progress: this.getProgress() })
  }

  private clearTimeout(): void {
    if (this.timer != null) {
      this.deps.clock.clearTimeout(this.timer)
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private emitTrack(message: string, data: Record<string, string | number | boolean | null>): void {
    this.emit({ type: 'track', message, data })
  }

  private async trackOp<T extends { order: Order }>(
    op: StrategyOrderOp,
    data: Record<string, string | number | boolean | null>,
    call: Promise<T>,
  ): Promise<T> {
    const events = ORDER_OP_TRACK_EVENTS[op]
    const startedAt = this.deps.clock.now()
    this.emitTrack(events.started, data)
    try {
      const result = await call
      this.emitTrack(events.succeeded, {
        ...data,
        durationMs: this.deps.clock.now() - startedAt,
        orderStatus: result.order.status,
      })
      return result
    } catch (err) {
      this.emitTrack(events.failed, {
        ...data,
        durationMs: this.deps.clock.now() - startedAt,
        error: formatUnknownError(err),
      })
      throw err
    }
  }

  getWorkingOrders() {
    if (this.currentOrder) {
      return {
        [this.currentOrder.order_id]: this.currentOrder,
      }
    } else {
      return {}
    }
  }
}
