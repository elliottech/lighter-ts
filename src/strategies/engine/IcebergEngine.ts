// Iceberg runtime. Works the total size as small resting limit chunks so only
// `restingChunkBaseAmount` is visible at a time, spread over at most
// `maxRestingOrders` live orders. Each tick (`repriceIntervalMs`) modifies the
// resting orders whose price has gone stale onto the new price, then tops the
// live resting total back up to one chunk. A repriced chunk keeps its size and
// its order id — only a chunk that dies on its own is replaced by a fresh one.
//
// Pricing: with `postOnly` the chunks chase the own-side top of book
// (buy=best bid, sell=best ask), bounded by the user's `limitPrice`; without
// it they rest at `limitPrice` or fill as taker when `limitPrice` crosses the book.
// Either way no chunk is priced past index ± PER_SLICE_SLIPPAGE_PCT, and no
// chunk is placed without an index.
// A remainder too small to rest as its own chunk is taken out with an IOC market
// order bounded by PER_SLICE_SLIPPAGE_PCT from both the book and the index.
//
// Fills are counted from ws-confirmed orders only: deltas from the streamed
// working-order updates plus the orders returned by submit/modify/cancel.

import {
  type Clock,
  ENGINE_ORDER_TYPE,
  ENGINE_TIF,
  type EngineEvent,
  type EngineEventListener,
  type FillUpdate,
  ICEBERG_DEFAULT_START_STATE,
  type IcebergConfig,
  type IcebergProgress,
  type IcebergResumeState,
  type MarketDataSource,
  type MarketMeta,
  type OrderClient,
  RESTING_STATUSES,
  type StrategyEngine,
  type StrategyStatus,
  type WorkingOrders,
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

const ICEBERG_ORDER_EXPIRY_MS = 60 * 60 * 1000

interface IcebergDeps {
  marketData: MarketDataSource
  orderClient: OrderClient
  clock: Clock
}

export class IcebergEngine implements StrategyEngine {
  private readonly config: IcebergConfig
  private readonly deps: IcebergDeps
  private readonly listeners = new Set<EngineEventListener>()

  private market: MarketMeta = null!
  private timer: number | null = null
  private status: StrategyStatus = 'running'
  private started = false
  private totalBaseAmount = 0
  private filledBaseAmount = 0
  private filledQuoteAmount = 0
  private makerBaseAmount = 0
  private nextActionAt: number | null = null
  private currentOrders: WorkingOrders = {}
  /** What awaits a ws-confirmed result: the order id for a modify/cancel,
   *  `true` for a create whose id is not known yet, `false` when idle. That
   *  result owns the fill accounting for its own order, so streamed updates
   *  for that one order must not credit (or clear the baseline) in the
   *  meantime. Every other order keeps streaming — a create has no id to
   *  collide with, and its own pushes are dropped as untracked until the
   *  submit result adopts it. */
  private resultInFlight: string | boolean = false

  private resumed = false

  constructor(
    config: IcebergConfig,
    deps: IcebergDeps,
    listener: EngineEventListener,
    resume?: IcebergResumeState,
  ) {
    this.config = config
    this.deps = deps
    this.on(listener)
    const { workingOrders, filledBaseAmount, filledQuoteAmount, makerBaseAmount } =
      resume ?? ICEBERG_DEFAULT_START_STATE
    this.totalBaseAmount = this.config.totalSize
    this.filledBaseAmount = filledBaseAmount
    this.filledQuoteAmount = filledQuoteAmount
    this.makerBaseAmount = makerBaseAmount
    this.resumed = !!resume
    const market = this.deps.marketData.getMarket(this.config.marketId)

    if (!market) {
      this.abort(`Market ${this.config.marketId} not found`)
      return
    }

    this.market = market

    this.currentOrders = {}
    for (const order of Object.values(workingOrders)) {
      if (RESTING_STATUSES.has(order.status)) {
        this.currentOrders[order.order_id] = order
      }
    }
    this.status = 'running'
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getProgress(): IcebergProgress {
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

    this.iceberg()
  }

  stop(reason = 'Stopped by user'): void {
    this.abort(reason)
  }

  onFillUpdate(update: FillUpdate): void {
    const order = update.restingOrder
    if (this.status !== 'running' || this.resultInFlight === order.order_id) {
      return
    }

    if (!(order.order_id in this.currentOrders)) {
      return
    }

    this.creditFill(order, null, true)
  }

  adoptOrder(order: Order, isMaker: boolean): void {
    if (this.status !== 'running') return
    this.creditFill(order, null, isMaker)
  }

  private getRestingBaseAmount(): number {
    return Object.values(this.currentOrders).reduce(
      (sum, val) =>
        sum +
        roundNumber(val.initial_base_amount - val.filled_base_amount, this.market.size_decimals),
      0,
    )
  }

  /** Size that tops the live resting total back up to one chunk (capped by
   *  the strategy's unplaced remainder) — other working orders may still be
   *  resting, so a full fresh chunk would oversize the exposure. */
  private getTargetRestingSize(chasePrice: number): number {
    const restingBaseAmount = this.getRestingBaseAmount()
    const remaining = roundNumber(
      this.totalBaseAmount - this.filledBaseAmount - restingBaseAmount,
      this.market.size_decimals,
    )

    const topUp = roundNumber(
      this.config.restingChunkBaseAmount - restingBaseAmount,
      this.market.size_decimals,
    )

    if (remaining <= 0 || topUp <= 0) {
      return 0
    }

    const minSliceSize = roundNumber(
      getMinSliceSize(this.market, chasePrice) * 1.2, // multiply by 1.2 to add error margin in case price changes
      this.market.size_decimals,
    )

    const targetRestingSize = Math.min(topUp, remaining)
    const remainingAfterThisOrder = roundNumber(
      remaining - targetRestingSize,
      this.market.size_decimals,
    )
    if (remainingAfterThisOrder > 0 && remainingAfterThisOrder < minSliceSize) {
      return remaining
    }
    return targetRestingSize
  }

  // ---- internals --------------------------------------------------------

  private scheduleNext() {
    if (this.status !== 'running') {
      return
    }

    if (this.timer != null) {
      return
    }
    this.nextActionAt = this.deps.clock.now() + this.config.repriceIntervalMs
    this.emitProgress()
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null
      void this.iceberg()
    }, this.config.repriceIntervalMs)
  }

  private async iceberg(): Promise<void> {
    if (this.status !== 'running') {
      return
    }

    await this.repriceOutdatedPriceOrders()

    if (this.status !== 'running') {
      return
    }

    if (this.filledBaseAmount >= this.totalBaseAmount) {
      this.complete()
      return
    }

    const price = this.getTargetPrice()

    if (price === null) {
      this.scheduleNext()
      return
    }

    const restingOrdersCount = Object.keys(this.currentOrders).length

    const baseAmountToPlace = this.getTargetRestingSize(price)

    const minSliceSize = getMinSliceSize(this.market, price)
    if (baseAmountToPlace > 0 && baseAmountToPlace < minSliceSize && restingOrdersCount === 0) {
      await this.submitFinalMarketOrder(baseAmountToPlace)
      return
    }

    const restingBaseAmount = this.getRestingBaseAmount()
    const remaining = roundNumber(
      this.totalBaseAmount - this.filledBaseAmount - restingBaseAmount,
      this.market.size_decimals,
    )

    const minRestingOrderThreshold = Math.max(
      roundNumber(
        this.config.restingChunkBaseAmount / this.config.maxRestingOrders,
        this.market.size_decimals,
      ),
      minSliceSize,
    )

    if (restingOrdersCount >= this.config.maxRestingOrders) {
      this.scheduleNext()
      return
    }

    if (baseAmountToPlace <= 0) {
      this.scheduleNext()
      return
    }

    // block chunks smaller than min threshold, but allow the last slice if it can rest
    if (
      baseAmountToPlace < minRestingOrderThreshold &&
      (baseAmountToPlace !== remaining || baseAmountToPlace < minSliceSize)
    ) {
      this.scheduleNext()
      return
    }

    this.resultInFlight = true
    try {
      const { order } = await this.trackOp(
        'submit',
        { orderType: 'limit' },
        this.deps.orderClient.submitOrder({
          accountIndex: this.config.accountIndex,
          orderBookIndex: this.market.market_id,
          baseAmount: convertFloatToBase(baseAmountToPlace, this.market.size_decimals),
          price: Math.max(1, convertFloatToBase(price, this.market.price_decimals)),
          isAsk: this.config.isAsk,
          orderType: ENGINE_ORDER_TYPE.limit,
          timeInForce: this.config.postOnly ? ENGINE_TIF.postOnly : ENGINE_TIF.goodTillTime,
          reduceOnly: this.config.reduceOnly ? 1 : 0,
          triggerPrice: 0,
          orderExpiry: this.deps.clock.now() + ICEBERG_ORDER_EXPIRY_MS,
          strategyOrderKind: StrategyOrderKind.Iceberg,
        }),
      )

      this.creditFill(order, null, true)

      if (this.status !== 'running' && RESTING_STATUSES.has(order.status)) {
        await this.cancelWorkingOrders({ [order.order_id]: order })
      }
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'iceberg',
          function: 'iceberg',
        },
      })
      this.abortIfNonRetryable(error)
    } finally {
      this.resultInFlight = false
    }

    this.scheduleNext()
  }

  /** The unplaced remainder is too small to rest as a limit chunk, so take it
   *  out with an IOC market order bounded by the per-slice slippage cap. */
  private async submitFinalMarketOrder(baseAmount: number): Promise<void> {
    const referencePrice =
      this.config.isAsk === 1
        ? this.deps.marketData.getBestBidPrice(this.market.market_id)
        : this.deps.marketData.getBestAskPrice(this.market.market_id)

    const indexPrice = this.deps.marketData.getIndexPrice(this.market.market_id)

    if (referencePrice === null || !indexPrice) {
      this.scheduleNext()
      return
    }

    const worstPrice = capAtBound(
      computeWorstExecutionPrice(PER_SLICE_SLIPPAGE_PCT, this.config.isAsk === 1, referencePrice),
      getIndexBoundPrice(indexPrice, PER_SLICE_SLIPPAGE_PCT, this.config.isAsk),
      this.config.isAsk,
    )
    const round = this.config.isAsk === 1 ? ceilNumber : floorNumber
    const bound = round(worstPrice, this.market.price_decimals)

    this.resultInFlight = true
    try {
      const { order } = await this.trackOp(
        'submit',
        { orderType: 'market' },
        this.deps.orderClient.submitOrder({
          accountIndex: this.config.accountIndex,
          orderBookIndex: this.market.market_id,
          baseAmount: convertFloatToBase(baseAmount, this.market.size_decimals),
          price: Math.max(1, convertFloatToBase(bound, this.market.price_decimals)),
          isAsk: this.config.isAsk,
          orderType: ENGINE_ORDER_TYPE.market,
          timeInForce: ENGINE_TIF.immediateOrCancel,
          reduceOnly: this.config.reduceOnly ? 1 : 0,
          triggerPrice: 0,
          orderExpiry: 0,
          strategyOrderKind: StrategyOrderKind.Iceberg,
        }),
      )

      this.creditFill(order, null)

      if (this.status !== 'running') {
        return
      }
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'iceberg',
          function: 'submitFinalMarketOrder',
        },
      })
      this.abortIfNonRetryable(error)
    } finally {
      this.resultInFlight = false
    }

    this.scheduleNext()
  }

  private async repriceOutdatedPriceOrders(): Promise<void> {
    for (const orderToReprice of Object.values(this.currentOrders)) {
      if (this.status !== 'running') return
      const newPrice = this.getTargetPrice()
      const indexBound = this.getIndexBound()
      if (newPrice === null || indexBound === null) return
      const orderPrice = orderToReprice.price
      const isOutdated =
        (this.config.isAsk ? orderPrice > newPrice : orderPrice < newPrice) ||
        capAtBound(orderPrice, indexBound, this.config.isAsk) !== orderPrice
      if (!isOutdated) continue
      this.resultInFlight = orderToReprice.order_id
      try {
        const { order } = await this.trackOp(
          'modify',
          { orderId: orderToReprice.order_id },
          this.deps.orderClient.modifyOrder({
            accountIndex: this.config.accountIndex,
            marketId: this.market.market_id,
            orderId: orderToReprice.order_id,
            clientOrderIndex: orderToReprice.client_order_index,
            baseAmount: convertFloatToBase(
              orderToReprice.initial_base_amount,
              this.market.size_decimals,
            ),
            price: Math.max(1, convertFloatToBase(newPrice, this.market.price_decimals)),
            triggerPrice: 0,
            isAsk: this.config.isAsk,
          }),
        )

        this.creditFill(order, null, true)
      } catch (error) {
        this.emit({
          type: 'sentry',
          error,
          tags: {
            strategy: 'iceberg',
            function: 'repriceOutdatedPriceOrders',
          },
        })
        this.abortIfNonRetryable(error)
        return
      } finally {
        this.resultInFlight = false
      }
    }
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
    void this.cancelWorkingOrders()
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
  private async cancelWorkingOrders(workingOrders: WorkingOrders = this.currentOrders) {
    for (const workingOrder of Object.values(workingOrders)) {
      this.resultInFlight = workingOrder.order_id
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
            strategy: 'iceberg',
            function: 'cancelWorkingOrders',
          },
        })
      } finally {
        this.resultInFlight = false
      }
    }
  }

  private isReduceOnlyExhausted(order: Order): boolean {
    return this.config.reduceOnly && order.status === OrderStatusEnum.CanceledReduceOnly
  }

  /** Credit a ws order's fills beyond the already-counted baseline snapshot. */
  private creditFill(order: Order, _: unknown, isMaker = false): void {
    const baselineOrder: Order | undefined = this.currentOrders[order.order_id]
    const baseDelta = order.filled_base_amount - (baselineOrder?.filled_base_amount ?? 0)
    this.filledBaseAmount = roundNumber(
      this.filledBaseAmount + baseDelta,
      this.market.size_decimals,
    )
    this.filledQuoteAmount += order.filled_quote_amount - (baselineOrder?.filled_quote_amount ?? 0)

    if (isMaker) {
      this.makerBaseAmount = roundNumber(
        this.makerBaseAmount + baseDelta,
        this.market.size_decimals,
      )
    }

    if (RESTING_STATUSES.has(order.status)) {
      this.currentOrders = { ...this.currentOrders, [order.order_id]: order }
      this.emit({ type: 'updateWorkingOrder', order })
    } else {
      if (baselineOrder) {
        const { [order.order_id]: _removed, ...rest } = this.currentOrders
        this.currentOrders = rest
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
      this.timer = null
    }
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private emitTrack(message: string, data: Record<string, string | number | boolean | null>): void {
    this.emit({ type: 'track', message, data })
  }

  /**
   * If user set postOnly it should do like a chase order
   * If user didnt set postOnly send orders at set limit price
   */
  private getCrossingPrice(): number | null {
    if (!this.config.postOnly) return this.config.limitPrice
    const price =
      this.config.isAsk === 1
        ? this.deps.marketData.getBestAskPrice(this.market.market_id)
        : this.deps.marketData.getBestBidPrice(this.market.market_id)
    if (price === null) {
      return null
    }
    return roundNumber(price, this.market.price_decimals)
  }

  private getIndexBound(): number | null {
    const indexPrice = this.deps.marketData.getIndexPrice(this.market.market_id)
    return indexPrice
      ? getIndexBoundPrice(indexPrice, PER_SLICE_SLIPPAGE_PCT, this.config.isAsk)
      : null
  }

  private getTargetPrice(): number | null {
    const crossingPrice = this.getCrossingPrice()
    const indexBound = this.getIndexBound()
    if (crossingPrice === null || indexBound === null) {
      return null
    }
    const round = this.config.isAsk === 1 ? ceilNumber : floorNumber
    return round(
      capAtBound(
        (this.config.isAsk ? Math.max : Math.min)(this.config.limitPrice, crossingPrice),
        indexBound,
        this.config.isAsk,
      ),
      this.market.price_decimals,
    )
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
    return this.currentOrders
  }
}
