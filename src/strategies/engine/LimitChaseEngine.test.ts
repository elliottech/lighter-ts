import { ApiError, type Order } from '../..'
import {
  type CancelInput,
  type CancelResult,
  type ChaseResumeState,
  type EngineEvent,
  type LimitChaseConfig,
  type MarketDataSource,
  type MarketMeta,
  type ModifyOrderInput,
  type ModifyResult,
  type OrderClient,
  type SubmitOrderInput,
  type SubmitResult,
} from './types'
import {
  OrderPriceGuardError,
  REDUCE_ONLY_EXHAUSTED_REASON,
  VolumeQuotaExhaustedError,
} from './errors'
import { assertOrderPriceNearIndex } from './planner'
import { beforeEach, describe, expect, it } from 'vitest'

import { LimitChaseEngine } from './LimitChaseEngine'
import { FakeClock, wsOrder, wsWorkingOrders } from './testUtils'

const MARKET: MarketMeta = {
  market_id: 0,
  size_decimals: 2,
  price_decimals: 2,
  min_base_amount: '1',
  min_quote_amount: '10',
  multiplier: '1',
  display_price_decimals: 2,
}

const GUARD_REASON = 'Order price 20007.49 is more than 10% above the index price 2400'

class FakeMarketData implements MarketDataSource {
  market: MarketMeta | undefined = MARKET
  connected = true
  indexPrice: number | null = 100
  markPrice: number | null = 100
  bestAskPrice: number | null = 100
  bestBidPrice: number | null = 100

  getMarket() {
    return this.market
  }

  getIndexPrice(): number | null {
    return this.indexPrice
  }

  getMarkPrice(): number | null {
    return this.markPrice
  }

  getMidPrice(): number | null {
    return this.markPrice
  }

  getBestBidPrice(): number | null {
    return this.bestBidPrice
  }

  getBestAskPrice(): number | null {
    return this.bestAskPrice
  }
}

class FakeOrderClient implements OrderClient {
  submitResult: Partial<SubmitResult> = {}
  /** Status the ws-confirmed order resolves with on submit. */
  submitStatus: Order['status'] = 'open'
  /** Extra fields merged into the ws-confirmed order on submit. */
  submitOrderOverrides: Partial<Order> = {}
  submitShouldThrow = false
  submitError: Error | null = null
  submitInputs: SubmitOrderInput[] = []
  modifyInputs: ModifyOrderInput[] = []
  cancelInputs: CancelInput[] = []

  /** When true, submits stay pending until released via releaseSubmits(). */
  submitDefer = false
  private pendingSubmits: (() => void)[] = []

  submitOrder(input: SubmitOrderInput): Promise<SubmitResult> {
    this.submitInputs.push(input)
    if (this.submitShouldThrow) {
      return Promise.reject(new Error('submit failed'))
    }
    if (this.submitError) {
      return Promise.reject(this.submitError)
    }
    // Mint a distinct id per submit (order-1, order-2, …) so a replacement is
    // distinguishable from the order it replaced — mirrors the venue.
    const result = {
      ...this.submitResult,
      order: wsOrder({
        order_id: `order-${this.submitInputs.length}`,
        price: input.price / 10 ** MARKET.price_decimals,
        initial_base_amount: input.baseAmount / 10 ** MARKET.size_decimals,
        status: this.submitStatus,
        ...this.submitOrderOverrides,
      })[0],
    }

    if (this.submitDefer) {
      return new Promise((resolve) => {
        this.pendingSubmits.push(() => resolve(result))
      })
    }

    return Promise.resolve(result)
  }

  releaseSubmits(): void {
    const pending = this.pendingSubmits
    this.pendingSubmits = []
    for (const release of pending) release()
  }

  modifyShouldThrow = false
  modifyError: Error | null = null
  cancelShouldThrow = false

  modifyOrder(input: ModifyOrderInput): Promise<ModifyResult> {
    this.modifyInputs.push(input)

    if (this.modifyShouldThrow) {
      return Promise.reject(new Error('modify failed'))
    }
    if (this.modifyError) {
      return Promise.reject(this.modifyError)
    }

    // Resolve with the ws-confirmed repriced order, mirroring the venue.
    return Promise.resolve({
      order: wsOrder({
        order_id: input.orderId,
        price: input.price / 10 ** MARKET.price_decimals,
        initial_base_amount: input.baseAmount / 10 ** MARKET.size_decimals,
        status: 'open',
      })[0],
    })
  }

  cancelOrder(input: CancelInput): Promise<CancelResult> {
    this.cancelInputs.push(input)
    if (this.cancelShouldThrow) {
      return Promise.reject(new Error('cancel failed'))
    }
    // Resolve with the ws-confirmed canceled order, mirroring the venue.
    return Promise.resolve({
      order: wsOrder({ order_id: input.orderId, status: 'canceled' })[0],
    })
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const makeConfig = (overrides: Partial<LimitChaseConfig> = {}): LimitChaseConfig => ({
  accountIndex: 3,
  marketId: 0,
  isAsk: 0 as const,
  totalSize: 1,
  reduceOnly: false,
  maxDistancePercent: 0,
  restingChunkBaseAmount: overrides.totalSize ?? 1,
  repriceIntervalMs: 1000,
  ...overrides,
})

describe('LimitChaseEngine', () => {
  let clock: FakeClock
  let marketData: FakeMarketData
  let orderClient: FakeOrderClient
  let events: EngineEvent[]

  beforeEach(() => {
    clock = new FakeClock()
    marketData = new FakeMarketData()
    orderClient = new FakeOrderClient()
    events = []
  })

  const makeEngine = (config = makeConfig(), resume?: ChaseResumeState) => {
    return new LimitChaseEngine(
      config,
      { marketData, orderClient, clock },
      (event) => events.push(event),
      resume,
    )
  }

  const status = (value: 'running' | 'completed' | 'aborted') =>
    events.find(
      (event): event is Extract<EngineEvent, { type: 'status' }> =>
        event.type === 'status' && event.status === value,
    )

  it('throws on a second start() without dispatching again', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()
    const sent = orderClient.submitInputs.length
    expect(sent).toBeGreaterThan(0)

    expect(() => engine.start()).toThrow('engine already started')
    await flush()
    expect(orderClient.submitInputs).toHaveLength(sent)
  })

  it('submits a post-only buy limit at the best bid', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(status('running')).toBeDefined()
    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]).toMatchObject({
      accountIndex: 3,
      orderBookIndex: 0,
      baseAmount: 100,
      price: 10000,
      isAsk: 0,
      orderType: 0,
      timeInForce: 2,
      reduceOnly: 0,
    })
  })

  it('submits a post-only sell limit at the best ask', async () => {
    const engine = makeEngine(makeConfig({ isAsk: 1 as const }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]!.price).toBe(10000)
    expect(orderClient.submitInputs[0]!.isAsk).toBe(1)
  })

  it('modifies the same working order when the own-side quote moves', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    marketData.bestBidPrice = 99.5
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toEqual([
      {
        accountIndex: 3,
        marketId: 0,
        orderId: 'order-1',
        clientOrderIndex: 0,
        baseAmount: 100,
        price: 9950,
        triggerPrice: 0,
        isAsk: 0,
      },
    ])
  })

  it('retries on the next tick when the modify fails', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()
    expect(orderClient.submitInputs).toHaveLength(1)

    orderClient.modifyShouldThrow = true
    marketData.bestBidPrice = 99.5
    clock.fireNext()
    await flush()

    // The order may still be resting: no cancel, no second order — just the
    // next tick retrying the modify.
    expect(orderClient.cancelInputs).toHaveLength(0)
    expect(orderClient.submitInputs).toHaveLength(1)
    expect(status('aborted')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)

    orderClient.modifyShouldThrow = false
    clock.fireNext()
    await flush()
    expect(orderClient.modifyInputs).toHaveLength(2)
  })

  it('releases an order that resolves after an abort instead of adopting it', async () => {
    const engine = makeEngine()
    orderClient.submitDefer = true
    engine.start()
    await flush()
    expect(orderClient.submitInputs).toHaveLength(1)

    engine.stop()
    expect(status('aborted')).toBeDefined()

    orderClient.releaseSubmits()
    await flush()

    // The resting order that resolved post-abort is canceled, not adopted,
    // and no further tick is armed.
    expect(orderClient.cancelInputs).toMatchObject([{ orderId: 'order-1' }])
    expect(clock.pendingCount()).toBe(0)
  })

  it('resubmits remaining size when the latest working order is canceled', async () => {
    const engine = makeEngine(makeConfig({ totalSize: 100 }))
    engine.start()
    await flush()

    marketData.bestBidPrice = 99.5
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'canceled',
        initial_base_amount: 100,
        filled_base_amount: 25,
        filled_quote_amount: 25 * 100,
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs).toHaveLength(2)
    expect(orderClient.submitInputs[1]).toMatchObject({
      baseAmount: 7500,
      price: 9950,
    })
    expect(status('aborted')).toBeUndefined()
  })

  it('places exactly one replacement when the working order expires', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()
    expect(orderClient.submitInputs).toHaveLength(1)

    marketData.bestBidPrice = 99.5
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'canceled-expired',
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs).toHaveLength(2)
    expect(status('aborted')).toBeUndefined()
  })

  it('replaces an expired order even when cancelling the dead order fails', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    orderClient.modifyShouldThrow = true
    orderClient.cancelShouldThrow = true
    marketData.bestBidPrice = 99.5
    clock.fireNext() // modify throws → catch → cancel fails → re-adopt, no replace
    await flush()
    expect(orderClient.submitInputs).toHaveLength(1)

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'canceled-expired',
      })[0],
    })
    await flush()
    expect(orderClient.submitInputs).toHaveLength(2)
    expect(status('aborted')).toBeUndefined()
  })

  it('aborts with the exchange error when the submit is rejected for margin', async () => {
    orderClient.submitError = new ApiError('not enough margin to create the order', 21739)
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(status('aborted')?.reason).toBe('not enough margin to create the order')
    expect(engine.getProgress().status).toBe('aborted')
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts with the guard reason when the order client refuses a submit', async () => {
    orderClient.submitError = new OrderPriceGuardError(GUARD_REASON)
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(status('aborted')?.reason).toBe(GUARD_REASON)
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts with the guard reason and cancels when the order client refuses a reprice', async () => {
    const engine = makeEngine(makeConfig({ isAsk: 1 as const }))
    engine.start()
    await flush()

    orderClient.modifyError = new OrderPriceGuardError(GUARD_REASON)
    marketData.bestAskPrice = 100.5
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs[0]).toMatchObject({ isAsk: 1 })
    expect(status('aborted')?.reason).toBe(GUARD_REASON)
    expect(orderClient.cancelInputs.map((c) => c.orderId)).toEqual(['order-1'])
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts with the reason when the order client gives up on volume quota', async () => {
    const error = new VolumeQuotaExhaustedError()
    orderClient.submitError = error
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(status('aborted')?.reason).toBe(error.message)
    expect(clock.pendingCount()).toBe(0)
  })

  it('keeps retrying when the submit fails for a transient reason', async () => {
    orderClient.submitShouldThrow = true
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)
  })

  it('aborts and cancels the working order when a reprice is rejected for margin', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    orderClient.modifyError = new ApiError('not enough margin to create the order', 21739)
    marketData.bestBidPrice = 99.5
    clock.fireNext()
    await flush()

    expect(status('aborted')?.reason).toBe('not enough margin to create the order')
    expect(orderClient.cancelInputs.map((c) => c.orderId)).toEqual(['order-1'])
    expect(orderClient.submitInputs).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts a reduce-only chase once the exchange reports no position left', async () => {
    const engine = makeEngine(makeConfig({ reduceOnly: true }))
    engine.start()
    await flush()

    orderClient.submitError = new ApiError('invalid reduce only direction', 21738)
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'canceled-expired',
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs).toHaveLength(2)
    expect(status('aborted')?.reason).toBe('invalid reduce only direction')
    expect(clock.pendingCount()).toBe(0)
  })

  it('uses streamed fill updates to track progress and complete', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'open',
        filled_base_amount: 0.4,
      })[0],
    })
    expect(engine.getProgress().filledBaseAmount).toBe(0.4)
    expect(status('completed')).toBeUndefined()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        filled_base_amount: 1,
      })[0],
    })
    expect(status('completed')).toBeDefined()
  })

  it('cancels the working order when stopped', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    engine.stop('user stopped')

    expect(status('aborted')).toBeDefined()
    expect(orderClient.cancelInputs).toEqual([
      { accountIndex: 3, marketId: 0, orderId: 'order-1', clientOrderIndex: 0 },
    ])
  })

  it('offsets buy price below best bid when maxDistancePercent is set', async () => {
    const engine = makeEngine(makeConfig({ maxDistancePercent: 1 }))
    engine.start()
    await flush()

    // bestBidPrice=100, distance=1% → order at 100*(1-0.01)=99 → 9900
    expect(orderClient.submitInputs[0]).toMatchObject({
      price: 9900,
      isAsk: 0,
    })
  })

  it('offsets sell price above best ask when maxDistancePercent is set', async () => {
    const engine = makeEngine(makeConfig({ isAsk: 1 as const, maxDistancePercent: 1 }))
    engine.start()
    await flush()

    // bestAskPrice=100, distance=1% → order at 100*(1+0.01)=101 → 10100
    expect(orderClient.submitInputs[0]).toMatchObject({
      price: 10100,
      isAsk: 1,
    })
  })

  it('continues following when adverse movement occurs with no abort', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    marketData.bestBidPrice = 100.2
    clock.fireNext()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 10020 })
  })

  it('clamps a buy down to the max index price distance', async () => {
    marketData.indexPrice = 100
    marketData.bestBidPrice = 100.2
    const engine = makeEngine(
      makeConfig({
        maxDistancePercent: 0,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]).toMatchObject({ price: 10010 })

    marketData.bestBidPrice = 100
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 10000 })
  })

  it('clamps a sell up to the max index price distance on modify', async () => {
    marketData.indexPrice = 100
    marketData.bestAskPrice = 100
    const engine = makeEngine(
      makeConfig({
        isAsk: 1 as const,
        maxDistancePercent: 0,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()

    marketData.bestAskPrice = 99.8
    clock.fireNext()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 9990 })
    expect(orderClient.cancelInputs).toHaveLength(0)

    marketData.bestAskPrice = 99.95
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 9995 })
  })

  it('follows the clamp bound as the index moves, even away from the book', async () => {
    marketData.indexPrice = 100
    marketData.bestBidPrice = 100.2
    const engine = makeEngine(
      makeConfig({
        maxDistancePercent: 0,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ price: 10010 })

    marketData.indexPrice = 99.8
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 9989 })

    marketData.indexPrice = 100.05
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 10015 })
  })

  it('bounds exactly at the index price when the distance is 0', async () => {
    marketData.indexPrice = 100
    marketData.bestBidPrice = 100.2
    const engine = makeEngine(makeConfig({ maxIndexPriceDistancePercent: 0 }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ price: 10000 })
  })

  it('skips while the index guard is enabled and index price is unavailable', async () => {
    marketData.indexPrice = null
    const engine = makeEngine(makeConfig({ maxIndexPriceDistancePercent: 0.1 }))
    engine.start()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.submitInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(1)

    marketData.indexPrice = 100
    clock.fireNext()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
  })

  it('caps a buy at index × (1 + slippage) when the bid runs away', async () => {
    marketData.bestBidPrice = 200
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ price: 10300 })

    marketData.bestBidPrice = 5000
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(0)

    marketData.indexPrice = 101
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 10403 })
  })

  it('floors a sell at index × (1 − slippage) when the ask runs away', async () => {
    marketData.bestAskPrice = 50
    const engine = makeEngine(makeConfig({ isAsk: 1 as const }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ price: 9700 })

    marketData.bestAskPrice = 1
    marketData.indexPrice = 99
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs.at(-1)).toMatchObject({ price: 9603 })
  })

  it('a bid that runs away for a while and comes back never trips the order guard', async () => {
    const submit = orderClient.submitOrder.bind(orderClient)
    const modify = orderClient.modifyOrder.bind(orderClient)
    orderClient.submitOrder = async (input) => {
      assertOrderPriceNearIndex(marketData, input.orderBookIndex, input.price, input.isAsk)
      return submit(input)
    }
    orderClient.modifyOrder = async (input) => {
      assertOrderPriceNearIndex(marketData, input.marketId, input.price, input.isAsk)
      return modify(input)
    }
    const engine = makeEngine()
    engine.start()
    await flush()

    for (const bid of [5000, 5000, 99.5]) {
      marketData.bestBidPrice = bid
      clock.fireNext()
      await flush()
    }

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.modifyInputs.map((input) => input.price)).toEqual([10300, 9950])
  })

  it('a looser max index distance cannot widen the band', async () => {
    marketData.bestBidPrice = 200
    const engine = makeEngine(makeConfig({ maxIndexPriceDistancePercent: 10 }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ price: 10300 })
  })

  it('skips while the index price is unavailable, even without the index guard', async () => {
    marketData.indexPrice = null
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.submitInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(1)

    marketData.indexPrice = 100
    clock.fireNext()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
  })

  it('never reprices the working order while the index price is unavailable', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    marketData.indexPrice = null
    marketData.bestBidPrice = 5000
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(0)
    expect(orderClient.cancelInputs).toHaveLength(0)
  })

  it('reschedules when top-of-book is unavailable at submit', async () => {
    marketData.bestBidPrice = null
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.submitInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(1)
  })

  // ----- reduce-only -----

  it('reduce-only: aborts when the submit resolves canceled-reduce-only', async () => {
    orderClient.submitStatus = 'canceled-reduce-only'
    const engine = makeEngine(makeConfig({ reduceOnly: true }))
    engine.start()
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(status('aborted')?.reason).toBe(REDUCE_ONLY_EXHAUSTED_REASON)
    expect(orderClient.submitInputs).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })

  it('reduce-only: aborts when the working order streams canceled-reduce-only', async () => {
    const engine = makeEngine(makeConfig({ reduceOnly: true }))
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'canceled-reduce-only',
        filled_base_amount: 0.25,
        filled_quote_amount: 0.25 * 100,
      })[0],
    })
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(status('aborted')?.reason).toBe(REDUCE_ONLY_EXHAUSTED_REASON)
    // Not resubmitted like a plain cancel would be.
    expect(orderClient.submitInputs).toHaveLength(1)
  })

  it('a canceled-reduce-only submit does not complete a non-reduce-only chase', async () => {
    orderClient.submitStatus = 'canceled-reduce-only'
    const engine = makeEngine(makeConfig({ reduceOnly: false }))
    engine.start()
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)
  })

  // ----- chunking -----

  it('chunked: submits only the chunk size initially', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 100,
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]).toMatchObject({ baseAmount: 10000 })
  })

  it('chunked: replenishes with a fresh chunk when the working order fills', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 100,
      }),
    )
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 100,
        filled_base_amount: 100,
        filled_quote_amount: 100 * 100,
      })[0],
    })
    await flush()

    expect(engine.getProgress().filledBaseAmount).toBe(100)
    expect(status('completed')).toBeUndefined()
    expect(orderClient.submitInputs).toHaveLength(2)
    expect(orderClient.submitInputs[1]).toMatchObject({ baseAmount: 10000 })
  })

  it('chunked: does not top up a partially filled chunk; reprices keep the size', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 100,
      }),
    )
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'open',
        price: 100,
        initial_base_amount: 100,
        filled_base_amount: 40,
        filled_quote_amount: 40 * 100,
      })[0],
    })

    clock.fireNext()
    await flush()
    expect(orderClient.modifyInputs).toHaveLength(0)

    marketData.bestBidPrice = 99.5
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]).toMatchObject({
      orderId: 'order-1',
      baseAmount: 10000,
      price: 9950,
    })
  })

  it('chunked: skips the tick when the price is unchanged', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 100,
      }),
    )
    engine.start()
    await flush()

    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(1)
  })

  it('chunked: market-orders a remaining tail below the venue minimum and completes', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 999.5,
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ baseAmount: 99950 })

    orderClient.submitOrderOverrides = {
      status: 'filled',
      filled_base_amount: 0.5,
      filled_quote_amount: 0.5 * 100,
    }
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 999.5,
        filled_base_amount: 999.5,
        filled_quote_amount: 999.5 * 100,
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs).toHaveLength(2)
    expect(orderClient.submitInputs[1]).toMatchObject({
      baseAmount: 50,
      price: 10300,
      isAsk: 0,
      orderType: 1,
      timeInForce: 0,
    })
    expect(status('completed')).toBeDefined()
    expect(engine.getProgress().filledBaseAmount).toBe(1000)
    expect(engine.getProgress().makerBaseAmount).toBe(999.5)
  })

  it('chunked: clamps the tail market bound to the max index price distance', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 999.5,
        maxIndexPriceDistancePercent: 1,
      }),
    )
    engine.start()
    await flush()

    orderClient.submitOrderOverrides = {
      status: 'filled',
      filled_base_amount: 0.5,
      filled_quote_amount: 0.5 * 100,
    }
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 999.5,
        filled_base_amount: 999.5,
        filled_quote_amount: 999.5 * 100,
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs).toHaveLength(2)
    expect(orderClient.submitInputs[1]).toMatchObject({
      baseAmount: 50,
      price: 10100,
      orderType: 1,
    })
    expect(status('completed')).toBeDefined()
  })

  it('chunked: caps the tail market bound at index × (1 + slippage) when the ask runs away', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 999.5,
      }),
    )
    engine.start()
    await flush()

    marketData.bestAskPrice = 5000
    orderClient.submitOrderOverrides = { status: 'canceled' }
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 999.5,
        filled_base_amount: 999.5,
        filled_quote_amount: 999.5 * 100,
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs[1]).toMatchObject({
      baseAmount: 50,
      price: 10300,
      orderType: 1,
    })
  })

  it('chunked: floors the sell tail market bound at index × (1 − slippage) when the bid runs away', async () => {
    const engine = makeEngine(
      makeConfig({
        isAsk: 1 as const,
        totalSize: 1000,
        restingChunkBaseAmount: 999.5,
      }),
    )
    engine.start()
    await flush()

    marketData.bestBidPrice = 1
    orderClient.submitOrderOverrides = { status: 'canceled' }
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 999.5,
        filled_base_amount: 999.5,
        filled_quote_amount: 999.5 * 100,
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs[1]).toMatchObject({
      baseAmount: 50,
      price: 9700,
      isAsk: 1,
      orderType: 1,
    })
  })

  it('chunked: sends no tail market order while the index price is unavailable', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 999.5,
      }),
    )
    engine.start()
    await flush()

    marketData.indexPrice = null
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 999.5,
        filled_base_amount: 999.5,
        filled_quote_amount: 999.5 * 100,
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(status('completed')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)

    marketData.indexPrice = 100
    clock.fireNext()
    await flush()

    expect(orderClient.submitInputs[1]).toMatchObject({
      baseAmount: 50,
      price: 10300,
      orderType: 1,
    })
    expect(status('completed')).toBeDefined()
  })

  it('chunked: completes after a single tail market order attempt even if it fails', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 999.5,
      }),
    )
    engine.start()
    await flush()

    orderClient.submitShouldThrow = true
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 999.5,
        filled_base_amount: 999.5,
        filled_quote_amount: 999.5 * 100,
      })[0],
    })
    await flush()

    expect(orderClient.submitInputs).toHaveLength(2)
    expect(status('completed')).toBeDefined()
    expect(clock.pendingCount()).toBe(0)
    expect(engine.getProgress().filledBaseAmount).toBe(999.5)
  })

  it('chunked: completes once the last chunk fills', async () => {
    const engine = makeEngine(
      makeConfig({
        totalSize: 1000,
        restingChunkBaseAmount: 500,
      }),
    )
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-1',
        status: 'filled',
        initial_base_amount: 500,
        filled_base_amount: 500,
        filled_quote_amount: 500 * 100,
      })[0],
    })
    await flush()
    expect(status('completed')).toBeUndefined()
    expect(orderClient.submitInputs).toHaveLength(2)

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'order-2',
        status: 'filled',
        initial_base_amount: 500,
        filled_base_amount: 500,
        filled_quote_amount: 500 * 100,
      })[0],
    })
    await flush()

    expect(status('completed')).toBeDefined()
    expect(orderClient.submitInputs).toHaveLength(2)
    expect(engine.getProgress().filledBaseAmount).toBe(1000)
  })

  // ----- resume -----

  it('resume: re-adopts a still-resting working order instead of submitting', async () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 0.25,
      filledQuoteAmount: 0.25 * 100,
      makerBaseAmount: 0.25,
      workingOrders: wsWorkingOrders({
        order_id: 'resumed-1',
        price: 100,
        filled_base_amount: 0.25,
        filled_quote_amount: 0.25 * 100,
      }),
    })
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(1)

    // The next tick reprices the re-adopted order as usual.
    marketData.bestBidPrice = 99.5
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toMatchObject([{ orderId: 'resumed-1', price: 9950 }])
  })

  it('resume: submits the remaining size once when the working order died while away', async () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 0.25,
      filledQuoteAmount: 0.25 * 100,
      makerBaseAmount: 0.25,
      workingOrders: wsWorkingOrders({
        order_id: 'resumed-1',
        price: 100,
        initial_base_amount: 0.75,
        filled_base_amount: 0.25,
        filled_quote_amount: 0.25 * 100,
      }),
    })
    // The worker replays the order's latest state before starting the engine.
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'resumed-1',
        status: 'canceled-expired',
        initial_base_amount: 0.75,
        filled_base_amount: 0.5,
        filled_quote_amount: 0.5 * 100,
      })[0],
    })
    await flush()
    expect(orderClient.submitInputs).toHaveLength(0)

    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]!.baseAmount).toBe(50)
    expect(status('aborted')).toBeUndefined()
  })

  it('adoptOrder: a resting unconfirmed order is credited and chased, not resubmitted', async () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 0.25,
      filledQuoteAmount: 0.25 * 100,
      makerBaseAmount: 0.25,
      workingOrders: {},
    })
    engine.adoptOrder(
      wsOrder({
        order_id: 'adopted-1',
        price: 100,
        initial_base_amount: 0.75,
        filled_base_amount: 0.1,
        filled_quote_amount: 0.1 * 100,
      })[0],
      true,
    )
    engine.start()
    await flush()

    expect(engine.getProgress()).toMatchObject({
      filledBaseAmount: 0.35,
      filledQuoteAmount: 35,
      makerBaseAmount: 0.35,
    })
    expect(Object.keys(engine.getWorkingOrders())).toEqual(['adopted-1'])
    expect(orderClient.submitInputs).toHaveLength(0)

    marketData.bestBidPrice = 99.5
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toMatchObject([{ orderId: 'adopted-1', price: 9950 }])
  })

  it('adoptOrder: a filled unconfirmed order only shrinks the remaining size', async () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 0.25,
      filledQuoteAmount: 0.25 * 100,
      makerBaseAmount: 0.25,
      workingOrders: {},
    })
    engine.adoptOrder(
      wsOrder({
        order_id: 'adopted-1',
        status: 'filled',
        initial_base_amount: 0.5,
        filled_base_amount: 0.5,
        filled_quote_amount: 0.5 * 100,
      })[0],
      true,
    )
    engine.start()
    await flush()

    expect(engine.getWorkingOrders()).not.toHaveProperty('adopted-1')
    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]!.baseAmount).toBe(25)
  })

  it('adoptOrder: completes without starting when the fills cover the size', async () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 0.5,
      filledQuoteAmount: 0.5 * 100,
      makerBaseAmount: 0.5,
      workingOrders: {},
    })
    engine.adoptOrder(
      wsOrder({
        order_id: 'adopted-1',
        status: 'filled',
        filled_base_amount: 0.5,
        filled_quote_amount: 0.5 * 100,
      })[0],
      true,
    )
    await flush()

    expect(status('completed')).toBeDefined()
    expect(engine.getProgress().status).toBe('completed')
    expect(orderClient.submitInputs).toHaveLength(0)
  })

  it('resume: submits the remaining size when the working order is gone', async () => {
    const engine = makeEngine(makeConfig({ totalSize: 100 }), {
      filledBaseAmount: 40,
      filledQuoteAmount: 40 * 100,
      makerBaseAmount: 40,
      workingOrders: {},
    })
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]!.baseAmount).toBe(6000)
  })

  it('resume: completes immediately when the reconciled fills cover the total', async () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 1,
      filledQuoteAmount: 100,
      makerBaseAmount: 1,
      workingOrders: {},
    })
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(0)
    expect(status('completed')).toBeDefined()
  })
})
