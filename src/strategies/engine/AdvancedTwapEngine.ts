import {
  type AdvancedTwapConfig,
  type Clock,
  ENGINE_ORDER_TYPE,
  ENGINE_TIF,
  type EngineEvent,
  type EngineEventListener,
  type FillUpdate,
  type MarketDataSource,
  type MarketMeta,
  type OrderClient,
  RESTING_STATUSES,
  type StrategyEngine,
  type StrategyStatus,
  type SubmitOrderInput,
  TWAP_DEFAULT_START_STATE,
  type TwapExecutionStyle,
  type TwapProgress,
  type TwapResumeState,
} from './types'
import {
  ORDER_OP_TRACK_EVENTS,
  StrategyEngineTrackEvents,
  type StrategyOrderOp,
} from '../trackEvents'
import { type Order, StrategyOrderKind, convertFloatToBase, roundNumber } from '../..'
import {
  REDUCE_ONLY_EXHAUSTED_REASON,
  formatUnknownError,
  isNonRetryableOrderError,
} from './errors'
import { capAtBound, createRng, getIndexBoundPrice, getMinSliceSize } from './planner'
import { OrderStatusEnum } from 'zklighter-perps'

// 28d - 1s, there's a few strategies that were canceled, I think due to not subtracting one second
const TWAP_LIMIT_ORDER_EXPIRY_MS = 28 * 24 * 60 * 60 * 1000 - 1000

const MIN_STALE_SLICE_WINDOW_MS = 5 * 60 * 1000

const FINAL_SWEEP_RETRY_MS = 10_000

const SCHEDULE_TOLERANCE: Record<TwapExecutionStyle, number> = {
  passive: 0.1,
  neutral: 0.05,
  aggressive: 0.01,
}

export interface EngineDeps {
  marketData: MarketDataSource
  orderClient: OrderClient
  clock: Clock
  /** epoch ms of the strategy record's creation — anchors the schedule. */
  createdAt: number
}

export class AdvancedTwapEngine implements StrategyEngine {
  private readonly config: AdvancedTwapConfig
  private readonly deps: EngineDeps
  private readonly listeners = new Set<EngineEventListener>()

  private market: MarketMeta = null!
  private timer: number | null = null
  private status: StrategyStatus = 'running'
  private started = false
  private rng: () => number = createRng(0)

  private totalBaseAmount = 0
  private filledBaseAmount = 0
  private filledQuoteAmount = 0
  private makerBaseAmount = 0

  private failedBaseAmount = 0
  private startAt = 0
  private endAt = 0

  /**
   * The full schedule, regenerated deterministically from the rng seed on
   * every start: slot i executes `slotSizes[i]` at `slotAts[i]`. Sizes are
   * jittered around total/sliceCount and normalized to sum exactly to the
   * total; intervals are jittered and normalized to span exactly the
   * duration. Only the number of consumed slots is persisted.
   */
  private slotAts: number[] = []
  private slotSizes: number[] = []
  private consumedSlices = 0

  private nextActionAt: number | null = null

  private currentOrder: Order | null = null
  private sliceInFlight = false
  private sliceIndex = 0

  private resultInFlight = false
  private resumed = false

  constructor(
    config: AdvancedTwapConfig,
    deps: EngineDeps,
    listener: EngineEventListener,
    resume?: TwapResumeState,
  ) {
    this.config = config
    this.deps = deps
    this.on(listener)
    const {
      workingOrders,
      filledBaseAmount,
      filledQuoteAmount,
      makerBaseAmount,
      failedBaseAmount,
      consumedSlices,
    } = { ...TWAP_DEFAULT_START_STATE, ...resume }
    this.totalBaseAmount = this.config.totalSize
    this.filledBaseAmount = filledBaseAmount
    this.filledQuoteAmount = filledQuoteAmount
    this.makerBaseAmount = makerBaseAmount
    this.failedBaseAmount = failedBaseAmount
    this.consumedSlices = consumedSlices
    this.resumed = !!resume

    const resumedOrders = Object.values(workingOrders)

    if (resumedOrders.length > 1) {
      this.abort(`Too many working orders`)
      return
    }
    this.currentOrder = resumedOrders[0] ?? null
    const market = this.deps.marketData.getMarket(this.config.marketId)

    if (!market) {
      this.abort(`Market ${this.config.marketId} not found`)
      return
    }

    this.market = market

    this.rng = createRng(this.deps.createdAt & 0xffffffff)
    this.status = 'running'
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getProgress(): TwapProgress {
    return {
      status: this.status,
      totalBaseAmount: this.totalBaseAmount,
      filledBaseAmount: this.filledBaseAmount,
      filledQuoteAmount: this.filledQuoteAmount,
      makerBaseAmount: this.makerBaseAmount,
      failedBaseAmount: this.failedBaseAmount,
      consumedSlices: this.consumedSlices,
      nextActionAt: this.status === 'running' ? this.nextActionAt : null,
    }
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
  }

  adoptOrder(order: Order, isMaker: boolean): void {
    if (this.status !== 'running') return
    this.creditFill(order, null, isMaker)
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
      failedBase: this.failedBaseAmount,
      resumed: this.resumed,
    })

    this.startAt = this.deps.clock.now()
    this.endAt = this.deps.createdAt + this.config.sliceCount * this.config.baseIntervalMs
    this.buildSchedule(this.deps.createdAt)
    this.nextActionAt = this.getNextSlotAt()
    this.emitProgress()

    void this.executeBoundary()
  }

  /**
   * Regenerates the slice schedule from the seeded rng. Each slot's size is
   * the average size jittered by a balanced draw, so every slot stays within
   * ±sizeJitter of the average AND the sizes sum exactly to the total
   * (cumulative rounding keeps each within an ulp of its ideal share).
   * Intervals work the same way, so the slots span exactly the duration.
   * Slot 0 executes at `scheduleStart`.
   */
  private buildSchedule(scheduleStart: number): void {
    const count = this.config.sliceCount
    const sizeJitters = this.drawBalancedJitter(count)
    const intervalJitters = this.drawBalancedJitter(count)

    const avgSize = this.totalBaseAmount / count

    this.slotAts = []
    this.slotSizes = []

    let sizeCum = 0
    let sizeCumRounded = 0
    let intervalCum = 0

    for (let i = 0; i < count; i++) {
      this.slotAts.push(scheduleStart + Math.round(intervalCum))
      intervalCum +=
        this.config.baseIntervalMs * (1 + intervalJitters[i]! * this.config.intervalJitter)

      sizeCum += avgSize * (1 + sizeJitters[i]! * this.config.sizeJitter)
      const rounded = this.roundBase(sizeCum)
      this.slotSizes.push(this.roundBase(rounded - sizeCumRounded))
      sizeCumRounded = rounded
    }
  }

  /**
   * Draws `count` values in [-1, 1] that sum to exactly 0. The raw draws'
   * excess is redistributed proportionally to each value's slack toward the
   * saturated end, which keeps every value inside [-1, 1].
   */
  private drawBalancedJitter(count: number): number[] {
    const draws: number[] = []

    for (let i = 0; i < count; i++) {
      draws.push(this.rng() * 2 - 1)
    }

    const excess = draws.reduce((sum, z) => sum + z, 0)

    if (excess === 0) {
      return draws
    }

    const slackOf = (z: number) => (excess > 0 ? z + 1 : 1 - z)
    const slack = draws.reduce((sum, z) => sum + slackOf(z), 0)

    return draws.map((z) => z - (excess * slackOf(z)) / slack)
  }

  stop(reason = 'Stopped by user'): void {
    this.abort(reason)
  }

  private getExecutionStyle(): TwapExecutionStyle {
    return this.config.executionStyle ?? 'aggressive'
  }

  private getScheduleTolerance(): number {
    return SCHEDULE_TOLERANCE[this.getExecutionStyle()]
  }

  private remainingToExecute() {
    return this.roundBase(this.totalBaseAmount - this.filledBaseAmount - this.failedBaseAmount)
  }

  private restingUnfilled(): number {
    return this.currentOrder
      ? this.roundBase(this.currentOrder.initial_base_amount - this.currentOrder.filled_base_amount)
      : 0
  }

  private async executeBoundary(): Promise<void> {
    if (this.status !== 'running') {
      return
    }

    this.sliceInFlight = true
    const sliceIndex = ++this.sliceIndex
    const startedAt = this.deps.clock.now()
    this.emitTrack(StrategyEngineTrackEvents.SLICE_STARTED, {
      sliceIndex,
      remainingBase: this.remainingToExecute(),
    })

    await this.runBoundary()
    this.sliceInFlight = false
    this.emitTrack(StrategyEngineTrackEvents.SLICE_ENDED, {
      sliceIndex,
      remainingBase: this.remainingToExecute(),
      durationMs: this.deps.clock.now() - startedAt,
    })
  }

  private async runBoundary(): Promise<void> {
    const now = this.deps.clock.now()
    const staleCutoff = now - Math.max(MIN_STALE_SLICE_WINDOW_MS, this.config.baseIntervalMs)

    const dueSlots = this.consumeDueSlots(now, staleCutoff)

    this.markFailed(dueSlots?.staleBase ?? 0)

    if (now >= this.endAt) {
      await this.runFinalBoundary(this.endAt < staleCutoff)
      return
    }

    await this.runRegularBoundary(dueSlots?.planned ?? 0)
  }

  private async runRegularBoundary(planned: number): Promise<void> {
    if (planned === 0) {
      this.scheduleNext()
      return
    }

    const slicePrice = this.getSlicePrice()

    if (slicePrice === null) {
      this.markFailed(planned)
    } else {
      const maxResting = this.roundBase(this.getScheduleTolerance() * this.totalBaseAmount)

      while (
        this.currentOrder === null &&
        planned < getMinSliceSize(this.market, slicePrice) &&
        this.consumedSlices < this.config.sliceCount
      ) {
        planned = this.roundBase(planned + this.slotSizes[this.consumedSlices]!)
        this.consumedSlices++
      }

      // Persist the consumed slot count before dispatching: a crash while the
      // order is in flight then under-executes (recovered by the final sweep)
      // instead of replaying the slots and executing them twice.
      this.emitProgress()

      await this.executeSlice(planned, slicePrice, maxResting)
    }

    if (this.status !== 'running') {
      await this.retireWorkingOrder()
      return
    }

    if (this.remainingToExecute() === 0 && this.currentOrder === null) {
      this.complete()
      return
    }

    this.scheduleNext()
  }

  private async runFinalBoundary(isStale: boolean): Promise<void> {
    const slicePrice = this.getSlicePrice()
    const planned = this.remainingToExecute()

    if (slicePrice === null || isStale) {
      await this.retireWorkingOrder()
      if (this.currentOrder === null) {
        this.markFailed(this.remainingToExecute())
      }
    } else {
      this.emitProgress()

      await this.executeSlice(planned, slicePrice, 0)
    }

    if (this.status !== 'running') {
      await this.retireWorkingOrder()
      return
    }

    if (this.currentOrder !== null) {
      this.scheduleNext(this.deps.clock.now() + FINAL_SWEEP_RETRY_MS)
      return
    }

    this.complete()
  }

  /**
   * Consumes every schedule slot that is due (slot time <= now). Slots older
   * than the stale window accumulate into `staleBase`, recent ones into
   * `planned`. Returns null when no slot was due.
   */
  private consumeDueSlots(
    now: number,
    staleCutoff: number,
  ): { planned: number; staleBase: number } | null {
    let consumed = false
    let planned = 0
    let staleBase = 0

    while (
      this.consumedSlices < this.config.sliceCount &&
      this.slotAts[this.consumedSlices]! <= now
    ) {
      const slotAt = this.slotAts[this.consumedSlices]!
      const sliceBase = this.slotSizes[this.consumedSlices]!

      if (slotAt < staleCutoff) {
        staleBase = this.roundBase(staleBase + sliceBase)
      } else {
        planned = this.roundBase(planned + sliceBase)
      }

      consumed = true
      this.consumedSlices++
    }

    return consumed ? { planned, staleBase } : null
  }

  private async executeSlice(
    sliceBase: number,
    slicePrice: number,
    maxResting: number,
  ): Promise<void> {
    if (this.currentOrder === null) {
      await this.postFreshSlice(sliceBase, slicePrice, maxResting)
      return
    }

    const remaining = this.remainingToExecute()
    const unfilled = this.restingUnfilled()

    let restingDelta: number
    let marketPart: number

    if (this.roundBase(unfilled + sliceBase) <= remaining) {
      restingDelta = Math.min(sliceBase, maxResting - unfilled)
      marketPart = sliceBase - restingDelta
    } else {
      restingDelta = remaining - sliceBase - unfilled
      marketPart = sliceBase
    }
    restingDelta = this.roundBase(restingDelta)
    marketPart = this.roundBase(marketPart)

    const { outcome, appliedGrowth } = await this.modifyWorkingOrder(restingDelta, slicePrice)

    if (outcome === 'failed') {
      return
    }

    if (outcome === 'terminal') {
      if (this.status !== 'running') {
        return
      }
      const freshBase = this.roundBase(
        Math.min(Math.max(0, restingDelta - appliedGrowth) + marketPart, this.remainingToExecute()),
      )
      if (freshBase > 0) {
        await this.postFreshSlice(freshBase, slicePrice, maxResting)
      }
      return
    }

    if (marketPart > 0) {
      // The resting snapshot after the modify is the confirmation of how much
      // of the resize actually applied — cap the market part so the combined
      // exposure can never exceed the remainder even on a partial resize.
      const safePart = this.roundBase(
        Math.min(marketPart, this.remainingToExecute() - this.restingUnfilled()),
      )
      if (safePart > 0) {
        await this.submitMarketOrder(safePart, slicePrice)
      }
    }
  }

  private async postFreshSlice(
    sliceBase: number,
    slicePrice: number,
    maxResting: number,
  ): Promise<void> {
    if (sliceBase <= 0) {
      return
    }

    const minSlice = getMinSliceSize(this.market, slicePrice)
    const limitPart = Math.min(sliceBase, maxResting)
    const marketPart = this.roundBase(sliceBase - limitPart)

    if (limitPart < minSlice) {
      await this.submitMarketOrder(sliceBase, slicePrice)
      return
    }

    await this.submitLimitSlice(limitPart, slicePrice)

    if (marketPart > 0) {
      await this.submitMarketOrder(marketPart, slicePrice)
    }
  }

  private async modifyWorkingOrder(
    restingDelta: number,
    slicePrice: number,
  ): Promise<{
    outcome: 'resting' | 'terminal' | 'failed'
    appliedGrowth: number
  }> {
    if (this.currentOrder === null) {
      return { outcome: 'terminal', appliedGrowth: 0 }
    }

    const targetBase = this.roundBase(this.currentOrder.initial_base_amount + restingDelta)

    if (targetBase < getMinSliceSize(this.market, slicePrice)) {
      await this.retireWorkingOrder()
      return {
        outcome: this.currentOrder === null ? 'terminal' : 'failed',
        appliedGrowth: 0,
      }
    }

    this.resultInFlight = true
    try {
      const { order } = await this.trackOp(
        'modify',
        { orderId: this.currentOrder.order_id, restingDelta },
        this.deps.orderClient.modifyOrder({
          accountIndex: this.config.accountIndex,
          marketId: this.market.market_id,
          orderId: this.currentOrder.order_id,
          clientOrderIndex: this.currentOrder.client_order_index,
          baseAmount: convertFloatToBase(targetBase, this.market.size_decimals),
          price: this.getSlicePriceUnits(slicePrice),
          triggerPrice: 0,
          isAsk: this.config.isAsk,
        }),
      )

      const appliedGrowth = Math.max(
        0,
        this.roundBase(order.initial_base_amount - this.currentOrder.initial_base_amount),
      )

      this.creditFill(order, this.currentOrder, true)

      return {
        outcome: RESTING_STATUSES.has(order.status) ? 'resting' : 'terminal',
        appliedGrowth,
      }
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'advanced-twap',
          function: 'modifyWorkingOrder',
        },
      })
      this.abortIfNonRetryable(error)
      return { outcome: 'failed', appliedGrowth: 0 }
    } finally {
      this.resultInFlight = false
    }
  }

  private async retireWorkingOrder(): Promise<void> {
    if (this.currentOrder === null) {
      return
    }

    this.resultInFlight = true
    try {
      const { order } = await this.trackOp(
        'cancel',
        { orderId: this.currentOrder.order_id },
        this.deps.orderClient.cancelOrder({
          accountIndex: this.config.accountIndex,
          marketId: this.config.marketId,
          orderId: this.currentOrder.order_id,
          clientOrderIndex: this.currentOrder.client_order_index,
        }),
      )

      this.creditFill(order, this.currentOrder, true)
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'advanced-twap',
          function: 'retireWorkingOrder',
        },
      })
      return
    } finally {
      this.resultInFlight = false
    }
  }

  private scheduleNext(nextAt = this.getNextSlotAt()): void {
    if (this.status !== 'running') {
      return
    }

    const delay = Math.max(0, nextAt - this.deps.clock.now())

    this.nextActionAt = nextAt
    this.emitProgress()
    this.timer = this.deps.clock.setTimeout(() => {
      void this.executeBoundary()
    }, delay)
  }

  private getNextSlotAt(): number {
    return this.consumedSlices < this.config.sliceCount
      ? this.slotAts[this.consumedSlices]!
      : this.endAt
  }

  private getReferencePrice(): number | null {
    const style = this.getExecutionStyle()

    if (style === 'neutral') {
      return this.deps.marketData.getMidPrice(this.market.market_id)
    }

    return (style === 'passive') === (this.config.isAsk === 1)
      ? this.deps.marketData.getBestAskPrice(this.market.market_id)
      : this.deps.marketData.getBestBidPrice(this.market.market_id)
  }

  private getSlicePrice(): number | null {
    const livePrice = this.getReferencePrice()

    if (!livePrice) {
      return null
    }

    const slicePrice = this.applyProtections(livePrice)

    return slicePrice === 'unavailable' ? null : slicePrice
  }

  private applyProtections(price: number): number | 'unavailable' {
    const indexPrice = this.deps.marketData.getIndexPrice(this.market.market_id)

    if (!indexPrice) {
      return 'unavailable'
    }

    const { isAsk, maxSlippagePct, maxIndexPriceDistancePercent } = this.config

    const capped = capAtBound(
      this.clampToPriceBound(price),
      getIndexBoundPrice(indexPrice, maxSlippagePct, isAsk),
      isAsk,
    )

    if (maxIndexPriceDistancePercent === undefined) {
      return capped
    }

    return capAtBound(
      capped,
      getIndexBoundPrice(indexPrice, maxIndexPriceDistancePercent, isAsk),
      isAsk,
    )
  }

  private clampToPriceBound(price: number): number {
    return this.config.isAsk === 1
      ? Math.max(price, this.config.minPrice ?? 0)
      : Math.min(price, this.config.maxPrice ?? Infinity)
  }

  private getSlicePriceUnits(clampedPrice: number): number {
    const units = Math.max(1, convertFloatToBase(clampedPrice, this.market.price_decimals))

    if (this.getExecutionStyle() !== 'aggressive') {
      return units
    }

    return this.config.isAsk === 1 ? units + 1 : units - 1
  }

  /**
   * A submit that throws is ambiguous: the order may still have landed on the
   * venue. The amount is written off as failed rather than re-dispatched —
   * retrying or falling back to a market order could execute it twice.
   */
  private async submitLimitSlice(baseAmount: number, slicePrice: number): Promise<void> {
    if (this.status !== 'running') {
      return
    }

    const price = this.applyProtections(slicePrice)

    if (price === 'unavailable') {
      this.markFailed(baseAmount)
      return
    }

    if (baseAmount < getMinSliceSize(this.market, price)) {
      await this.submitMarketOrder(baseAmount, price)
      return
    }

    try {
      const { order } = await this.trackOp(
        'submit',
        { orderType: 'limit' },
        this.deps.orderClient.submitOrder(this.buildLimitOrderInput(baseAmount, price)),
      )

      this.creditFill(order, null, true)
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'advanced-twap',
          function: 'submitLimitSlice',
        },
      })
      this.abortIfNonRetryable(error)
      this.markFailed(baseAmount)
    }
  }

  private async submitMarketOrder(
    baseAmount: number,
    referencePrice: number,
  ): Promise<Order | null> {
    if (this.status !== 'running') {
      return null
    }

    const bound = this.getProtectedTakerPrice(referencePrice)

    if (bound === null) {
      this.markFailed(baseAmount)
      return null
    }

    try {
      const { order } = await this.trackOp(
        'submit',
        { orderType: 'market' },
        this.deps.orderClient.submitOrder(this.buildMarketOrderInput(baseAmount, bound)),
      )

      this.creditFill(order, null, false)
      this.markFailed(this.roundBase(baseAmount - order.filled_base_amount))
      return order
    } catch (error) {
      this.emit({
        type: 'sentry',
        error,
        tags: {
          strategy: 'advanced-twap',
          function: 'submitMarketOrder',
        },
      })
      this.abortIfNonRetryable(error)
      this.markFailed(baseAmount)
      return null
    }
  }

  private isReduceOnlyExhausted(order: Order): boolean {
    return this.config.reduceOnly && order.status === OrderStatusEnum.CanceledReduceOnly
  }

  private markFailed(baseAmount: number): void {
    if (this.status !== 'running' || baseAmount === 0) {
      return
    }

    this.failedBaseAmount = this.roundBase(this.failedBaseAmount + baseAmount)
    this.emitTrack(StrategyEngineTrackEvents.SLICE_FAILED, {
      failedBase: baseAmount,
      totalFailedBase: this.failedBaseAmount,
    })
    this.emitProgress()
  }

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

    if (this.remainingToExecute() === 0 && this.currentOrder === null) {
      this.complete()
    } else if (this.isReduceOnlyExhausted(order)) {
      this.abort(REDUCE_ONLY_EXHAUSTED_REASON)
    }
  }

  private roundBase(value: number): number {
    return roundNumber(value, this.market.size_decimals)
  }

  private getProtectedTakerPrice(referencePrice: number): number | null {
    const slippageFactor = this.config.maxSlippagePct / 100
    const pushed =
      this.config.isAsk === 1
        ? referencePrice * (1 - slippageFactor)
        : referencePrice * (1 + slippageFactor)

    const capped = this.applyProtections(pushed)

    return capped === 'unavailable' ? null : capped
  }

  private buildLimitOrderInput(baseAmount: number, clampedPrice: number): SubmitOrderInput {
    return {
      accountIndex: this.config.accountIndex,
      orderBookIndex: this.market.market_id,
      baseAmount: convertFloatToBase(baseAmount, this.market.size_decimals),
      price: this.getSlicePriceUnits(clampedPrice),
      isAsk: this.config.isAsk,
      orderType: ENGINE_ORDER_TYPE.limit,
      timeInForce: ENGINE_TIF.goodTillTime,
      reduceOnly: this.config.reduceOnly ? 1 : 0,
      triggerPrice: 0,
      orderExpiry: this.deps.clock.now() + TWAP_LIMIT_ORDER_EXPIRY_MS,
      strategyOrderKind: StrategyOrderKind.AdvancedTwap,
    }
  }

  private buildMarketOrderInput(baseAmount: number, bound: number): SubmitOrderInput {
    return {
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
      strategyOrderKind: StrategyOrderKind.AdvancedTwap,
    }
  }

  private complete(): void {
    if (this.status !== 'running') {
      return
    }

    this.clearTimer()
    this.status = 'completed'
    this.emitTrack(StrategyEngineTrackEvents.COMPLETED, {
      filledBase: this.filledBaseAmount,
      failedBase: this.failedBaseAmount,
      totalBase: this.totalBaseAmount,
      elapsedMs: this.deps.clock.now() - this.startAt,
    })
    this.emitProgress()
    this.emit({ type: 'status', status: 'completed' })
  }

  private abort(reason: string): void {
    if (this.status !== 'running') {
      return
    }

    this.clearTimer()
    this.status = 'aborted'
    this.emitTrack(StrategyEngineTrackEvents.ABORTED, {
      reason,
      filledBase: this.filledBaseAmount,
      failedBase: this.failedBaseAmount,
      totalBase: this.totalBaseAmount,
    })

    if (!this.sliceInFlight) {
      this.retireWorkingOrder()
    }
    this.emitProgress()
    this.emit({ type: 'status', status: 'aborted', reason })
  }

  private abortIfNonRetryable(error: unknown): void {
    if (isNonRetryableOrderError(error)) {
      this.abort(formatUnknownError(error))
    }
  }

  private emitProgress(): void {
    this.emit({ type: 'progress', progress: this.getProgress() })
  }

  private clearTimer(): void {
    if (this.timer !== null) {
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
