// Domain types and injected interfaces shared by the strategy engines.

import type { Order, OrderBookDetail, StrategyOrderKind } from '../..'
import { OrderStatusEnum } from 'zklighter-perps'

export type IsAsk = 0 | 1

/** WS statuses in which an order is (or is about to be) resting on the book. */
export const RESTING_STATUSES = new Set<string>([
  OrderStatusEnum.InProgress,
  OrderStatusEnum.Pending,
  OrderStatusEnum.Open,
])

export const ENGINE_ORDER_TYPE = {
  limit: 0,
  market: 1,
} as const

export const ENGINE_TIF = {
  immediateOrCancel: 0,
  goodTillTime: 1,
  postOnly: 2,
} as const

/**
 * The engine's market view is a strict subset of the venue's OrderBookDetail.
 * We `Pick<>` instead of maintaining a parallel interface so field names stay
 * in sync with the SDK automatically and we don't need a conversion layer.
 *
 * SpotOrderBookDetail carries the same fields with identical types, so spot
 * details are accepted structurally without further work.
 *
 * `market_id` is the only identifier the engine deals in. Symbols are a
 * display concern handled by the UI layer. `min_base_amount` /
 * `min_quote_amount` matter for limit-style child orders, which rest on the
 * book and must satisfy the venue's minimum order sizes.
 */
export type MarketMeta = Pick<
  OrderBookDetail,
  | 'market_id'
  | 'size_decimals'
  | 'price_decimals'
  | 'min_base_amount'
  | 'min_quote_amount'
  | 'multiplier'
  | 'display_price_decimals'
>

/**
 * Child-order style for a TWAP slice:
 *  - aggressive: market IOC protected by the per-slice slippage bound
 *  - neutral:    plain limit (GTT) at the mid price
 *  - passive:    limit (GTT) at the own-side top of book
 */
export type TwapExecutionStyle = 'passive' | 'neutral' | 'aggressive'

/**
 * User-facing configuration for an Advanced TWAP strategy (human units).
 *
 * Per-slice slippage tolerance mirrors the backend's per-order slippage (see
 * `PER_SLICE_SLIPPAGE_PCT`), not the user's UI preference and not the 100%
 * native TWAP applies to the parent. It also caps every child price at that
 * distance from the index, so a thin book can never walk the strategy away
 * from the index.
 */
export interface AdvancedTwapConfig {
  accountIndex: number
  /** Venue market id — the canonical identifier for the market. */
  marketId: number
  /** 0 = buy / long, 1 = sell / short. */
  isAsk: IsAsk
  /** Total size to execute, in human (float) base units. */
  totalSize: number
  /** Number of child slices to split the parent order into. */
  sliceCount: number
  /** Average gap between slices, in milliseconds. */
  baseIntervalMs: number
  /** 0..1 — fraction by which each interval may randomly deviate. */
  intervalJitter: number
  /** 0..1 — fraction by which each slice size may randomly deviate. */
  sizeJitter: number
  reduceOnly: boolean
  /**
   * Per-slice slippage tolerance in PERCENT, used to compute the protective
   * price bound on each child market order. Mirrors the backend's per-order
   * slippage (`PER_SLICE_SLIPPAGE_PCT`). No child order, limit or market,
   * is priced past index × (1 ± this); nothing executes without an index.
   */
  maxSlippagePct: number
  /** Child-order style. Absent means 'aggressive' (= historical behavior). */
  executionStyle?: TwapExecutionStyle
  /**
   * Optional price floor for SELLS, in human units. While the reference price
   * is below it the strategy pauses (defers slices) instead of executing.
   */
  minPrice?: number
  /**
   * Optional price cap for BUYS, in human units. While the reference price is
   * above it the strategy pauses (defers slices) instead of executing.
   */
  maxPrice?: number
  /**
   * Optional side-aware max distance from the live index price, in percent
   * ("wick protection"). Buys never execute above index × (1 + d), sells
   * never below index × (1 − d), re-evaluated at every slice. Fails closed:
   * nothing executes while the index price is unavailable.
   */
  maxIndexPriceDistancePercent?: number
}

export type ChunkUnit = 'base' | 'percent' | 'quote'

/**
 * Client-side chase-limit strategy. Places one resting limit order at the
 * user's own-side top of book (buy=best bid, sell=best ask), then modifies the
 * same order as that quote moves until it fills, aborts, or reaches the max
 * adverse chase distance.
 */
export interface LimitChaseConfig {
  accountIndex: number
  marketId: number
  /** 0 = buy / long, 1 = sell / short. */
  isAsk: IsAsk
  /** Total size to execute, in human (float) base units. */
  totalSize: number
  reduceOnly: boolean
  /** Offset from the own-side top of book, in percent. 0 = chase the raw BBO. */
  maxDistancePercent: number
  /** Optional side-aware max distance from index price, in percent. */
  maxIndexPriceDistancePercent?: number
  /** Resting chunk size, in human (float) base units. */
  restingChunkBaseAmount: number
  /** How often to re-check the book and modify the working order. */
  repriceIntervalMs: number
}

export interface IcebergConfig {
  accountIndex: number
  marketId: number
  isAsk: IsAsk
  totalSize: number
  reduceOnly: boolean
  postOnly: boolean
  restingChunkBaseAmount: number
  repriceIntervalMs: number
  limitPrice: number
  maxRestingOrders: number
}

/**
 * Discriminant for every strategy type the framework knows about. Add new
 * strategies here and register a factory in worker/factories.ts + UI metadata
 * in catalog.ts.
 */
export type StrategyKind = 'advanced-twap' | 'chase-limit' | 'iceberg'

/**
 * Union of every strategy's config. Currently single-member; widen to a
 * discriminated union (keyed by the strategy's own field) as kinds are added.
 */
export type StrategyConfig = AdvancedTwapConfig | LimitChaseConfig | IcebergConfig

/**
 * Generic engine contract. Every strategy implements this so the worker host
 * and the manager stay strategy-agnostic.
 *
 * The model is intentionally minimal: a strategy can only be started or
 * stopped (= aborted). `start` optionally takes a resume seed so an
 * interrupted strategy (reload, crash) continues from its reconciled
 * progress; if a strategy can't continue (disconnect, guardrail breach)
 * it aborts with a reason.
 */
export interface StrategyEngine {
  start(): void
  stop(reason?: string): void
  onFillUpdate(update: FillUpdate): void
  /**
   * Credits an order the strategy sent but never saw confirmed (see
   * `StrategyRecord.unconfirmedOrders`): its fills count in full, and a
   * resting one becomes a working order. Called before `start()`.
   */
  adoptOrder(order: Order, isMaker: boolean): void
  on(listener: EngineEventListener): () => void
  getProgress(): StrategyProgress
  getWorkingOrders(): WorkingOrders
}

/**
 * Seed for restarting a strategy that was interrupted mid-run (page reload,
 * crash). Fill totals are the reconciled cumulative progress; `workingOrders`
 * holds the latest reconciled snapshot of each of the strategy's resting
 * orders keyed by `order_id`, present only while still active on the book (a
 * terminal order's fills are already folded into the totals).
 */
export interface BaseResumeState {
  filledBaseAmount: number
  filledQuoteAmount: number
  makerBaseAmount: number
  workingOrders: WorkingOrders
}

/** Working (resting limit) orders keyed by `order_id`. */
export type WorkingOrders = Record<string, Order>

/**
 * An order the strategy has sent (or is about to send) whose ws state has not
 * arrived yet. Persisted before the order is signed so a worker lost in the
 * meantime can still find the order by its client order index on resume.
 */
export interface UnconfirmedOrder {
  marketId: number
  /** `ENGINE_ORDER_TYPE`: a limit order's fills are credited as maker. */
  orderType: number
  sentAt: number
}

/** Unconfirmed orders keyed by `client_order_index`. */
export type UnconfirmedOrders = Record<string, UnconfirmedOrder>

export type ChaseResumeState = BaseResumeState

export interface TwapResumeState extends BaseResumeState {
  failedBaseAmount: number
  consumedSlices: number
}

export type IcebergResumeState = BaseResumeState

const BASE_DEFAULT_START_STATE: BaseResumeState = {
  filledBaseAmount: 0,
  filledQuoteAmount: 0,
  makerBaseAmount: 0,
  workingOrders: {},
}

export const CHASE_DEFAULT_START_STATE: ChaseResumeState = BASE_DEFAULT_START_STATE

export const TWAP_DEFAULT_START_STATE: TwapResumeState = {
  ...BASE_DEFAULT_START_STATE,
  failedBaseAmount: 0,
  consumedSlices: 0,
}

export const ICEBERG_DEFAULT_START_STATE: IcebergResumeState = BASE_DEFAULT_START_STATE

/** What the engine hands to the OrderClient to place one child order. */
export interface SubmitOrderInput {
  accountIndex: number
  orderBookIndex: number
  /** integer base units */
  baseAmount: number
  /** integer price units (priceDecimals applied) */
  price: number
  isAsk: IsAsk
  orderType: number
  timeInForce: number
  reduceOnly: 0 | 1
  triggerPrice: number
  orderExpiry: number
  /** Strategy that placed the order, encoded into its client_order_index. */
  strategyOrderKind: StrategyOrderKind
}

export interface SubmitResult {
  /** The ws-confirmed order as first seen after the submit (terminal state
   *  for market IOC orders, so it carries the ACTUAL fill). */
  order: Order
}

export interface ModifyResult {
  /** The ws-confirmed order once the modify applied (or it went inactive). */
  order: Order
}

export interface CancelResult {
  /** The ws-confirmed final order: canceled, or filled if the cancel lost. */
  order: Order
}

export interface CancelInput {
  accountIndex: number
  marketId: number
  orderId: string
  /** Identifies the order in the ws state, where changes are confirmed. */
  clientOrderIndex: number
}

export interface ModifyOrderInput {
  accountIndex: number
  marketId: number
  orderId: string
  /** Identifies the order in the ws state, where changes are confirmed. */
  clientOrderIndex: number
  /** integer base units — the order's NEW resting size. */
  baseAmount: number
  /** integer price units */
  price: number
  triggerPrice: number
  isAsk: IsAsk
}

export interface FillUpdate {
  /** Latest ws state of the strategy's working (limit) order. */
  restingOrder: Order
}

/** Live market data */
export interface MarketDataSource {
  getMarket(marketId: number): MarketMeta | undefined
  /** Index price in human (float) units, or null if unavailable. */
  getIndexPrice(marketId: number): number | null
  /** Mark price in human (float) units, or null if unavailable. */
  getMarkPrice(marketId: number): number | null
  getMidPrice(marketId: number): number | null
  /** Best bid in human (float) units, or null if unavailable. */
  getBestBidPrice(marketId: number): number | null
  /** Best ask in human (float) units, or null if unavailable. */
  getBestAskPrice(marketId: number): number | null
}

/** Order transport, injected (WASM-via-RPC in the worker, Node signer server-side). */
export interface OrderClient {
  submitOrder(input: SubmitOrderInput): Promise<SubmitResult>
  modifyOrder(input: ModifyOrderInput): Promise<ModifyResult>
  cancelOrder(input: CancelInput): Promise<CancelResult>
}

/** Injectable clock so timing is testable and swappable (worker vs node). */
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
}

/**
 * A strategy is only ever in one of three states:
 *  - running:   actively scheduling and submitting child orders
 *  - completed: all child orders submitted successfully, parent size done
 *  - aborted:   stopped before completion (user, browser close, guardrail,
 *               disconnect, RPC failure, …).
 */
export type StrategyStatus = 'running' | 'completed' | 'aborted'

/** Fields shared by every strategy's progress snapshot. */
interface BaseProgress {
  status: StrategyStatus
  /** human base units */
  totalBaseAmount: number
  filledBaseAmount: number
  /** Quote notional of the fills (human units) — avg price = quote / base. */
  filledQuoteAmount: number
  /** Portion of filledBaseAmount filled via resting limit orders. */
  makerBaseAmount: number
  /**
   * Maker/taker base volume recomputed from the venue's REST trades endpoint
   * (`getTradesHistory` by order_index, aggregated) each time one of the
   * strategy's orders leaves the book. Maintained by the main-thread
   * StrategyManager — engines never report these, and the store's patch-merge
   * keeps them intact when engine progress events land. Optional: absent on
   * records that predate the fields and until the first lookup completes.
   */
  makerBaseAmountV2?: number
  takerBaseAmountV2?: number
  /**
   * Epoch ms of the engine's next scheduled action (TWAP: next slice
   * boundary; chase: next reprice check), or null when none is scheduled.
   * Reported by the engine itself so the UI never reconstructs the schedule.
   */
  nextActionAt: number | null
  /**
   * Abort reason
   */
  reason?: string
}

export interface TwapProgress extends BaseProgress {
  /** Number of schedule slots already consumed (executed or written off). */
  consumedSlices: number
  failedBaseAmount: number
}

export type ChaseLimitProgress = BaseProgress

export type IcebergProgress = BaseProgress

export type StrategyProgress =
  | TwapProgress
  | ChaseLimitProgress
  // oxlint-disable-next-line typescript/no-duplicate-type-constituents -- Iceberg progress is a separate extension point.
  | IcebergProgress

/**
 * A persisted strategy instance. Generic over its config/progress so the
 * record store stays strategy-agnostic: it only ever sees `StrategyConfig` /
 * `StrategyProgress`, never a specific kind. Per-kind code narrows via the
 * `TwapStrategyRecord` / `ChaseLimitStrategyRecord` aliases below.
 */
export interface StrategyRecord<
  TConfig extends StrategyConfig = StrategyConfig,
  TProgress extends StrategyProgress = StrategyProgress,
> {
  id: string
  kind: StrategyKind
  config: TConfig
  progress: TProgress
  /** Latest ws snapshot of each of the strategy's working (resting limit)
   *  orders, keyed by `order_id`. Set by the manager on each limit submit and
   *  ws update; this routes WS fill updates, survives reloads for cleanup,
   *  and is the fill baseline a resumed session reconciles the venue's
   *  current order state against. */
  workingOrders: WorkingOrders
  /** Orders in flight: written before the submit, dropped once the order is
   *  either credited or tracked in `workingOrders`. */
  unconfirmedOrders?: UnconfirmedOrders
  createdAt: number
}

export type TwapStrategyRecord = StrategyRecord<AdvancedTwapConfig, TwapProgress>

export type ChaseLimitStrategyRecord = StrategyRecord<LimitChaseConfig, ChaseLimitProgress>

export type IcebergStrategyRecord = StrategyRecord<IcebergConfig, IcebergProgress>

/** Narrow a generic record to an Advanced-TWAP record by its kind. */
export const isTwapRecord = (record: StrategyRecord): record is TwapStrategyRecord =>
  record.kind === 'advanced-twap'

export type EngineEvent =
  | { type: 'progress'; progress: StrategyProgress }
  | { type: 'status'; status: StrategyStatus; reason?: string }
  | {
      type: 'track'
      message: string
      data?: Record<string, string | number | boolean | null>
    }
  | {
      /** The order's latest ws state while it rests, emitted whenever the
       *  engine credits it: the persisted snapshot is the baseline a resumed
       *  engine credits against. */
      type: 'updateWorkingOrder'
      order: Order
    }
  | {
      /** The order's final ws state, emitted once when it leaves the book. */
      type: 'removeWorkingOrder'
      order: Order
    }
  | {
      type: 'sentry'
      error: unknown
      tags: unknown
      /** The worker bundle's `_sentryDebugIds`, which main's Sentry SDK cannot see. */
      debugIds?: Record<string, string>
    }

export type EngineEventListener = (event: EngineEvent) => void
