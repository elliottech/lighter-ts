import {
  type AdvancedTwapConfig,
  type CancelInput,
  type CancelResult,
  type EngineEvent,
  type MarketDataSource,
  type MarketMeta,
  type ModifyOrderInput,
  type ModifyResult,
  type OrderClient,
  type SubmitOrderInput,
  type SubmitResult,
  type TwapResumeState,
} from './types'
import { ApiError } from '../..'
import { OrderPriceGuardError, REDUCE_ONLY_EXHAUSTED_REASON } from './errors'
import { StrategyEngineTrackEvents } from '../trackEvents'
import { assertOrderPriceNearIndex } from './planner'
import { beforeEach, describe, expect, it } from 'vitest'

import { AdvancedTwapEngine } from './AdvancedTwapEngine'
import { FakeClock, wsOrder, wsWorkingOrders } from './testUtils'

const MARKET: MarketMeta = {
  market_id: 1,
  size_decimals: 5,
  price_decimals: 2,
  min_base_amount: '0',
  min_quote_amount: '0',
  multiplier: '1',
  display_price_decimals: 2,
}

const GUARD_REASON = 'Order price 20007.49 is more than 10% above the index price 2400'

class FakeMarketData implements MarketDataSource {
  market: MarketMeta | undefined = MARKET
  connected = true
  price: number | null = 50_000
  bestBid: number | null = 49_990
  bestAsk: number | null = 50_010
  indexPrice: number | null = 50_000

  getMarket(marketId: number) {
    return this.market && marketId === this.market.market_id ? this.market : undefined
  }

  getIndexPrice(): number | null {
    return this.indexPrice
  }
  getMarkPrice(): number | null {
    return this.price
  }
  getMidPrice(): number | null {
    return this.price
  }
  getBestBidPrice(): number | null {
    return this.bestBid
  }
  getBestAskPrice(): number | null {
    return this.bestAsk
  }
}

interface PendingSubmit {
  input: SubmitOrderInput
  resolve: (r: Partial<SubmitResult>) => void
  reject: (err: Error) => void
}

class FakeOrderClient implements OrderClient {
  autoResolve: Partial<SubmitResult> | null = {}

  autoReject: Error | null = null
  pending: PendingSubmit[] = []

  inputs: SubmitOrderInput[] = []

  cancelInputs: CancelInput[] = []

  autoCancelResolve: Partial<CancelResult> = {}

  cancelReject: Error | null = null

  modifyInputs: ModifyOrderInput[] = []

  autoModifyResolve: Partial<ModifyResult> = {}

  modifyReject: Error | null = null

  modifyDefer = false
  pendingModifies: {
    input: ModifyOrderInput
    resolve: (r: Partial<ModifyResult>) => void
  }[] = []

  private withOrder(input: SubmitOrderInput, r: Partial<SubmitResult>): SubmitResult {
    return {
      order:
        r.order ??
        wsOrder({
          initial_base_amount: input.baseAmount / 1e5,
          status: input.orderType === 1 ? 'canceled' : 'open',
          order_id: input.orderType === 1 ? `ioc-${this.inputs.length}` : 'auto',
        })[0],
    }
  }

  submitOrder(input: SubmitOrderInput): Promise<SubmitResult> {
    this.inputs.push(input)
    if (this.autoReject) return Promise.reject(this.autoReject)
    if (this.autoResolve) {
      return Promise.resolve(this.withOrder(input, this.autoResolve))
    }
    return new Promise((resolve, reject) => {
      this.pending.push({
        input,
        resolve: (r) => resolve(this.withOrder(input, r)),
        reject,
      })
    })
  }
  modifyOrder(input: ModifyOrderInput): Promise<ModifyResult> {
    this.modifyInputs.push(input)
    if (this.modifyReject) return Promise.reject(this.modifyReject)
    if (this.modifyDefer) {
      return new Promise((resolve) => {
        this.pendingModifies.push({
          input,
          resolve: (r) => resolve(this.withModifyOrder(input, r)),
        })
      })
    }
    return Promise.resolve(this.withModifyOrder(input, this.autoModifyResolve))
  }

  private withModifyOrder(input: ModifyOrderInput, r: Partial<ModifyResult>): ModifyResult {
    return {
      order:
        r.order ??
        wsOrder({
          order_id: input.orderId,
          initial_base_amount: input.baseAmount / 1e5,
        })[0],
    }
  }
  cancelOrder(input: CancelInput): Promise<CancelResult> {
    this.cancelInputs.push(input)
    if (this.cancelReject) return Promise.reject(this.cancelReject)
    return Promise.resolve({
      order:
        this.autoCancelResolve.order ?? wsOrder({ order_id: input.orderId, status: 'canceled' })[0],
    })
  }
}

const makeConfig = (overrides: Partial<AdvancedTwapConfig> = {}): AdvancedTwapConfig => ({
  accountIndex: 0,
  marketId: 1,
  isAsk: 0,
  totalSize: 0.001,
  sliceCount: 3,
  baseIntervalMs: 1000,
  intervalJitter: 0,
  sizeJitter: 0,
  reduceOnly: false,
  maxSlippagePct: 1,
  ...overrides,
})

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Resume state with fills priced at 50k and maker-only volume by default. */
const resumeState = (overrides: Partial<TwapResumeState> = {}): TwapResumeState => {
  const filled = overrides.filledBaseAmount ?? 0
  return {
    filledBaseAmount: filled,
    filledQuoteAmount: filled * 50_000,
    makerBaseAmount: filled,
    workingOrders: {},
    failedBaseAmount: 0,
    consumedSlices: 0,
    ...overrides,
  }
}

describe('AdvancedTwapEngine', () => {
  let clock: FakeClock
  let marketData: FakeMarketData
  let orderClient: FakeOrderClient
  let events: EngineEvent[]

  const reset = () => {
    clock = new FakeClock()
    marketData = new FakeMarketData()
    orderClient = new FakeOrderClient()
    events = []
  }

  beforeEach(reset)

  const makeEngine = (config = makeConfig(), createdAt = 0, resume?: TwapResumeState) => {
    return new AdvancedTwapEngine(
      config,
      { marketData, orderClient, clock, createdAt },
      (e) => events.push(e),
      resume,
    )
  }

  const status = (s: 'running' | 'completed' | 'aborted') =>
    events.find(
      (e): e is Extract<EngineEvent, { type: 'status' }> => e.type === 'status' && e.status === s,
    )

  const marketOrders = () => orderClient.inputs.filter((i) => i.orderType === 1)

  it('emits status=running + progress on start', () => {
    makeEngine().start()
    expect(status('running')).toBeDefined()
    expect(events.some((e) => e.type === 'progress')).toBe(true)
  })

  it('runs the first boundary inline on start (no clock fire needed)', async () => {
    makeEngine(makeConfig({ executionStyle: 'passive', sliceCount: 10 })).start()
    await flush()
    expect(orderClient.inputs).toHaveLength(1)
    expect(clock.pendingCount()).toBe(1)
  })

  it('aborts on construction if the market is unknown', () => {
    marketData.market = undefined
    const engine = makeEngine()
    const a = status('aborted')
    expect(a).toBeDefined()
    expect(a!.reason).toMatch(/not found/i)
    expect(() => engine.start()).toThrow()
    expect(orderClient.inputs).toHaveLength(0)
  })

  it('throws on a second start() without dispatching again', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()
    const sent = orderClient.inputs.length
    expect(sent).toBeGreaterThan(0)

    expect(() => engine.start()).toThrow('engine already started')
    await flush()
    expect(orderClient.inputs).toHaveLength(sent)
  })

  it('stop() aborts a running engine with the given reason', () => {
    const engine = makeEngine()
    engine.start()
    engine.stop('user cancelled')
    const a = status('aborted')
    expect(a).toBeDefined()
    expect(a!.reason).toBe('user cancelled')
  })

  it('abort does not touch failedBaseAmount', async () => {
    const engine = makeEngine(
      makeConfig({ executionStyle: 'passive', totalSize: 100, sliceCount: 10 }),
    )
    engine.start()
    await flush()
    engine.stop('turned off')
    expect(engine.getProgress().failedBaseAmount).toBe(0)
  })

  it('a slice with no reference price is failed, the strategy keeps running', async () => {
    const engine = makeEngine(
      makeConfig({ executionStyle: 'passive', totalSize: 100, sliceCount: 10 }),
    )
    engine.start()
    await flush()
    marketData.price = null
    clock.fireNext()
    await flush()
    expect(status('aborted')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)

    expect(engine.getProgress().failedBaseAmount).toBe(10)
  })

  it('fails closed: a missing index fails the slice when wick protection is on', async () => {
    marketData.indexPrice = null
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs).toHaveLength(0)
    expect(engine.getProgress().failedBaseAmount).toBe(25)
    expect(engine.getProgress().status).toBe('running')

    marketData.indexPrice = 50_000
    clock.fireNext()
    await flush()
    expect(orderClient.inputs.length).toBeGreaterThan(0)
  })

  it('a slice whose submits throw is written off as failed, the strategy keeps running', async () => {
    orderClient.autoReject = new Error('network down')
    const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4 }))
    engine.start()
    await flush()
    expect(status('aborted')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)
    expect(engine.getProgress().failedBaseAmount).toBe(25)
  })

  it('aborts with the exchange error when a submit is rejected for margin', async () => {
    orderClient.autoReject = new ApiError('not enough margin to create the order', 21739)
    const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4 }))
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(status('aborted')?.reason).toBe('not enough margin to create the order')
    expect(engine.getProgress().status).toBe('aborted')
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts with the guard reason when the order client refuses a submit', async () => {
    orderClient.autoReject = new OrderPriceGuardError(GUARD_REASON)
    const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4 }))
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(status('aborted')?.reason).toBe(GUARD_REASON)
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts with the guard reason when the order client refuses a modify', async () => {
    const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4 }))
    engine.start()
    await flush()
    const submits = orderClient.inputs.length

    orderClient.modifyReject = new OrderPriceGuardError(GUARD_REASON)
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.inputs).toHaveLength(submits)
    expect(status('aborted')?.reason).toBe(GUARD_REASON)
    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })

  it('passes the order side with every modify so the order client can guard it', async () => {
    const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 1 }))
    engine.start()
    await flush()
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs[0]).toMatchObject({ isAsk: 1 })
  })

  it('aborts a reduce-only strategy once the exchange reports no position left', async () => {
    const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, reduceOnly: true }))
    engine.start()
    await flush()
    expect(status('aborted')).toBeUndefined()
    const submittedBeforeReject = orderClient.inputs.length

    orderClient.autoReject = new ApiError('invalid reduce only direction', 21738)
    clock.fireNext()
    await flush()

    expect(status('aborted')?.reason).toBe('invalid reduce only direction')
    expect(clock.pendingCount()).toBe(0)
    const submittedAtAbort = orderClient.inputs.length
    expect(submittedAtAbort).toBeGreaterThan(submittedBeforeReject)

    clock.fireNext()
    await flush()
    expect(orderClient.inputs).toHaveLength(submittedAtAbort)
  })

  it('completes once fills cover total − failed', async () => {
    const engine = makeEngine(
      makeConfig({ executionStyle: 'passive', totalSize: 100, sliceCount: 10 }),
    )
    marketData.price = null
    engine.start()
    await flush()
    marketData.price = 50_000
    clock.fireNext()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'filled',
        filled_base_amount: 90,
        initial_base_amount: 90,
      })[0],
    })
    expect(status('completed')).toBeDefined()
  })

  it('adoptOrder: a filled unconfirmed market slice is credited as taker before start', () => {
    const engine = makeEngine(
      makeConfig({ totalSize: 100 }),
      0,
      resumeState({ filledBaseAmount: 30 }),
    )
    engine.adoptOrder(
      wsOrder({
        order_id: 'adopted-1',
        status: 'filled',
        type: 'market',
        filled_base_amount: 10,
        filled_quote_amount: 10 * 50_000,
      })[0],
      false,
    )

    expect(engine.getProgress()).toMatchObject({
      status: 'running',
      filledBaseAmount: 40,
      filledQuoteAmount: 40 * 50_000,
      makerBaseAmount: 30,
    })
    expect(engine.getWorkingOrders()).toEqual({})
  })

  it('resume: recent missed slices are combined into the first boundary', async () => {
    clock.advance(3000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
      0,
      resumeState({ filledBaseAmount: 30, consumedSlices: 1 }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(2)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(orderClient.inputs[1]!.baseAmount).toBe(20 * 1e5)
    expect(engine.getProgress().failedBaseAmount).toBe(20)
  })

  it('resume: slices older than the stale window land in failedBaseAmount', async () => {
    clock.advance(480_000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 60_000,
      }),
      0,
      resumeState({ filledBaseAmount: 10, consumedSlices: 1 }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(2)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(orderClient.inputs[1]!.baseAmount).toBe(50 * 1e5)
    expect(engine.getProgress().failedBaseAmount).toBe(70)
    expect(clock.nextDueAt()).toBe(540_000)
  })

  it('resume: the stale window scales with intervals longer than 5 minutes', async () => {
    // Slot 0 fires at 0; resuming 6 minutes late is within a 30-min window.
    clock.advance(360_000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1_800_000,
      }),
      0,
      resumeState(),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(engine.getProgress().failedBaseAmount).toBe(0)
  })

  it('resume: past endAt but within the stale window sweeps the remainder', async () => {
    clock.advance(12_000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
      0,
      resumeState({ filledBaseAmount: 90, consumedSlices: 10 }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.orderType).toBe(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(status('completed')).toBeDefined()
  })

  it('resume: past endAt by more than the stale window takes nothing', async () => {
    orderClient.autoCancelResolve = {
      order: wsOrder({
        order_id: 'resumed-1',
        status: 'canceled',
        initial_base_amount: 5,
        filled_base_amount: 0,
      })[0],
    }

    clock.advance(600_000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
      0,
      resumeState({
        filledBaseAmount: 90,
        consumedSlices: 10,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 5,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(0)
    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(orderClient.cancelInputs[0]!.orderId).toBe('resumed-1')
    expect(status('completed')).toBeDefined()
  })

  it('resume: with no consumed slices the schedule starts at its anchor', async () => {
    clock.advance(10_000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
      10_000,
      resumeState({ filledBaseAmount: 50 }),
    )
    engine.start()
    await flush()

    expect(engine.getProgress().failedBaseAmount).toBe(0)

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
  })

  it('resume: a not-yet-due boundary does not advance consumedSlices', async () => {
    clock.advance(3200)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
      0,
      resumeState({ filledBaseAmount: 30, consumedSlices: 4 }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(0)
    expect(engine.getProgress().consumedSlices).toBe(4)
    expect(clock.nextDueAt()).toBe(4000)
  })

  const failedSizes = () =>
    events
      .filter(
        (e): e is Extract<EngineEvent, { type: 'track' }> =>
          e.type === 'track' && e.message === StrategyEngineTrackEvents.SLICE_FAILED,
      )
      .map((e) => e.data!.failedBase as number)

  it('generated slice sizes stay within the jitter bound and sum to the total', async () => {
    marketData.bestBid = null
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        sizeJitter: 0.3,
      }),
      7,
    )
    engine.start()
    await flush()
    while (clock.pendingCount() > 0 && engine.getProgress().status === 'running') {
      clock.fireNext()
      await flush()
    }

    const sizes = failedSizes()
    expect(sizes).toHaveLength(10)
    for (const size of sizes) {
      expect(size).toBeGreaterThanOrEqual(10 * 0.7 - 1e-9)
      expect(size).toBeLessThanOrEqual(10 * 1.3 + 1e-9)
    }
    expect(engine.getProgress().failedBaseAmount).toBe(100)
    expect(status('completed')).toBeDefined()
  })

  it('resume regenerates the same schedule from the seed', async () => {
    const config = makeConfig({
      executionStyle: 'passive',
      totalSize: 100,
      sliceCount: 10,
      sizeJitter: 0.3,
      intervalJitter: 0.5,
    })

    marketData.bestBid = null
    clock.advance(99)
    makeEngine(config, 99).start()
    await flush()
    const slot1 = clock.nextDueAt()!
    clock.fireNext()
    await flush()
    const slot2 = clock.nextDueAt()!
    clock.fireNext()
    await flush()
    const slot3 = clock.nextDueAt()!
    const sizes = failedSizes()
    expect(sizes).toHaveLength(3)
    expect(slot1).toBeLessThan(slot2)

    reset()
    marketData.bestBid = null
    clock.advance(slot2)
    makeEngine(config, 99, resumeState({ consumedSlices: 2 })).start()
    await flush()

    expect(failedSizes()).toEqual([sizes[2]])
    expect(clock.nextDueAt()).toBe(slot3)
  })

  it('neutral slices submit a GTT limit at the mid price with a long expiry', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()

    const input = orderClient.inputs[0]!
    expect(input.orderType).toBe(0)
    expect(input.timeInForce).toBe(1)
    expect(input.price).toBe(5_000_000)

    expect(input.orderExpiry).toBeGreaterThanOrEqual(27 * 24 * 60 * 60 * 1000)
  })

  it('passive buy rests a GTT limit at the best bid; passive sell at the best ask', async () => {
    let engine = makeEngine(makeConfig({ executionStyle: 'passive', sliceCount: 1, isAsk: 0 }))
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.orderType).toBe(0)
    expect(orderClient.inputs[0]!.timeInForce).toBe(1)
    expect(orderClient.inputs[0]!.price).toBe(4_999_000)

    reset()
    engine = makeEngine(makeConfig({ executionStyle: 'passive', sliceCount: 1, isAsk: 1 }))
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.timeInForce).toBe(1)
    expect(orderClient.inputs[0]!.price).toBe(5_001_000)
  })

  it('aggressive buy rests one tick inside the spread; sell one tick above the bid', async () => {
    let engine = makeEngine(makeConfig({ sliceCount: 1, isAsk: 0 }))
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(5_000_999)

    reset()
    engine = makeEngine(makeConfig({ sliceCount: 1, isAsk: 1 }))
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_999_001)
  })

  it('grows the resting order by the slice size and reprices it', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        isAsk: 0,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(5 * 1e5)

    marketData.bestBid = 49_980
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    const grow = orderClient.modifyInputs[0]!
    expect(grow.orderId).toBe('auto')
    expect(grow.baseAmount).toBe(10 * 1e5)
    expect(grow.price).toBe(4_998_000)
    expect(orderClient.inputs).toHaveLength(1)
  })

  it('caps the resting remainder at the style tolerance; the rest is a market IOC', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.baseAmount).toBe(5 * 1e5)
    expect(marketOrders()[0]!.baseAmount).toBe(20 * 1e5)

    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]!.baseAmount).toBe(5 * 1e5)
    expect(orderClient.modifyInputs[0]!.price).toBe(5_000_000)

    expect(marketOrders()).toHaveLength(2)
    expect(marketOrders()[1]!.baseAmount).toBe(25 * 1e5)
    expect(marketOrders()[1]!.timeInForce).toBe(0)
  })

  it('a modify that resolves terminal (filled underneath) posts the slice fresh', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        isAsk: 0,
      }),
    )
    engine.start()
    await flush()

    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'auto',
        status: 'filled',
        filled_base_amount: 5,
        filled_quote_amount: 5 * 50_000,
        initial_base_amount: 5,
      })[0],
    }
    clock.fireNext()
    await flush()

    expect(engine.getProgress().filledBaseAmount).toBe(5)
    expect(orderClient.inputs).toHaveLength(2)
    expect(orderClient.inputs[1]!.orderType).toBe(0)
    expect(orderClient.inputs[1]!.baseAmount).toBe(5 * 1e5)
  })

  it('an unconfirmed modify skips the slice and keeps the working order', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        isAsk: 0,
      }),
    )
    engine.start()
    await flush()

    orderClient.modifyReject = new Error('timeout')
    clock.fireNext()
    await flush()

    expect(engine.getProgress().failedBaseAmount).toBe(0)
    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.cancelInputs).toHaveLength(0)
    expect(status('aborted')).toBeUndefined()
  })

  it('ignores a fill update racing an in-flight modify (no double credit)', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 90,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs).toHaveLength(1)

    orderClient.modifyDefer = true
    clock.fireNext()
    await flush()
    expect(orderClient.pendingModifies).toHaveLength(1)

    engine.onFillUpdate({
      restingOrder: wsOrder({
        status: 'filled',
        initial_base_amount: 9,
        filled_base_amount: 9,
        filled_quote_amount: 450_000,
      })[0],
    })
    expect(engine.getProgress().filledBaseAmount).toBe(0)

    orderClient.pendingModifies[0]!.resolve({
      order: wsOrder({
        status: 'filled',
        initial_base_amount: 9,
        filled_base_amount: 9,
        filled_quote_amount: 450_000,
      })[0],
    })
    await flush()

    expect(engine.getProgress().filledBaseAmount).toBe(9)
    expect(orderClient.inputs).toHaveLength(2)
  })

  it('combines slots skipped by a long-running slice into one immediate slice', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.baseAmount).toBe(5 * 1e5)

    clock.advance(2500)
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(marketOrders()).toHaveLength(1)
    expect(marketOrders()[0]!.baseAmount).toBe(500000)
    expect(clock.nextDueAt()).toBe(3000)
  })

  it('a grown modify that fills does not re-post its resting part', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(5 * 1e5)

    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'auto',
        status: 'filled',
        initial_base_amount: 10,
        filled_base_amount: 10,
        filled_quote_amount: 10 * 50_000,
      })[0],
    }
    clock.fireNext()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(engine.getProgress().filledBaseAmount).toBe(10)
  })

  it('a modify that loses to the fill re-posts the whole slice', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()

    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'auto',
        status: 'filled',
        initial_base_amount: 5,
        filled_base_amount: 5,
        filled_quote_amount: 5 * 50_000,
      })[0],
    }
    clock.fireNext()
    await flush()

    expect(orderClient.inputs).toHaveLength(2)
    expect(orderClient.inputs[1]!.baseAmount).toBe(5 * 1e5)
    expect(engine.getProgress().filledBaseAmount).toBe(5)
  })

  it('retires the resting order when the remainder is below the slice', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
      }),
      0,
      resumeState({
        failedBaseAmount: 96,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 5,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(0)
    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(orderClient.cancelInputs[0]!.orderId).toBe('resumed-1')
    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.orderType).toBe(0)
    expect(orderClient.inputs[0]!.baseAmount).toBe(4 * 1e5)
    expect(marketOrders()).toHaveLength(0)
  })

  it('still markets the slice after a confirmed shrink of the resting order', async () => {
    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'resumed-1',
        filled_base_amount: 0,
        initial_base_amount: 10,
      })[0],
    }
    clock.advance(1000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 4,
        baseIntervalMs: 1000,
        isAsk: 0,
      }),
      0,
      resumeState({
        filledBaseAmount: 60,
        consumedSlices: 1,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 12,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(marketOrders()).toHaveLength(1)
    expect(marketOrders()[0]!.baseAmount).toBe(27 * 1e5)
  })

  it('caps the resting order when unfilled plus the slice sums to the remainder in floats', async () => {
    clock.advance(2000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 0.6,
        sliceCount: 3,
        baseIntervalMs: 1000,
        isAsk: 0,
      }),
      0,
      resumeState({
        filledBaseAmount: 0.3,
        consumedSlices: 2,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 0.1,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]!.baseAmount).toBe(0.06 * 1e5)
    expect(marketOrders()).toHaveLength(1)
    expect(marketOrders()[0]!.baseAmount).toBe(0.24 * 1e5)
  })

  it('caps the market part when a shrink does not apply', async () => {
    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'resumed-1',
        filled_base_amount: 0,
        initial_base_amount: 12,
      })[0],
    }
    clock.advance(1000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 4,
        baseIntervalMs: 1000,
        isAsk: 0,
      }),
      0,
      resumeState({
        filledBaseAmount: 60,
        failedBaseAmount: 10,
        consumedSlices: 1,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 12,
        }),
      }),
    )
    engine.start()
    await flush()

    // The overshoot shrink targets 5 but the venue reports 12 still resting,
    // so the market part is capped at remaining (30) − resting (12) = 18.
    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]!.baseAmount).toBe(5 * 1e5)
    expect(marketOrders()).toHaveLength(1)
    expect(marketOrders()[0]!.baseAmount).toBe(18 * 1e5)
  })

  it('retires the resting order when nothing is left to execute', async () => {
    orderClient.autoCancelResolve = {
      order: wsOrder({
        order_id: 'resumed-1',
        status: 'canceled',
        initial_base_amount: 5,
        filled_base_amount: 0,
      })[0],
    }
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
      }),
      0,
      resumeState({
        filledBaseAmount: 95,
        failedBaseAmount: 5,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 5,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(0)
    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(orderClient.cancelInputs[0]!.orderId).toBe('resumed-1')
    expect(marketOrders()).toHaveLength(0)
    expect(status('completed')).toBeDefined()
  })

  it.each([
    ['passive', 4, [], 0],
    ['neutral', 4, [3], 3],
    ['aggressive', 1, [3, 4], 7],
  ] as const)(
    '%s: the slice excess above the resting threshold goes out as a market IOC',
    async (style, firstLimit, markets, failedAfter) => {
      const engine = makeEngine(
        makeConfig({
          executionStyle: style,
          totalSize: 100,
          sliceCount: 25,
          isAsk: 0,
        }),
      )
      engine.start()
      await flush()

      expect(orderClient.inputs[0]!.baseAmount).toBe(firstLimit * 1e5)

      clock.fireNext()
      await flush()

      expect(marketOrders().map((o) => o.baseAmount)).toEqual(markets.map((m) => m * 1e5))
      expect(engine.getProgress().failedBaseAmount).toBe(failedAfter)
    },
  )

  it('a thrown submit is not re-dispatched: later slices exclude the failed amount', async () => {
    orderClient.autoReject = new Error('network down')
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'aggressive',
        totalSize: 100,
        sliceCount: 4,
      }),
    )
    engine.start()
    await flush()

    expect(engine.getProgress().failedBaseAmount).toBe(25)

    orderClient.autoReject = null
    clock.fireNext()
    await flush()

    expect(orderClient.inputs.at(-1)!.baseAmount).toBeLessThanOrEqual(25 * 1e5)
  })

  it('the taker price applies slippage then re-caps at the price bound', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
        maxPrice: 49_000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_900_000)

    clock.fireNext()
    await flush()

    const ioc = marketOrders()[0]!

    expect(ioc.price).toBe(4_900_000)
  })

  it('the taker price re-caps at the wick bound', async () => {
    marketData.indexPrice = 49_000
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_904_900)

    clock.fireNext()
    await flush()

    const ioc = marketOrders()[0]!
    expect(ioc.price).toBe(4_904_900)
  })

  it('sell taker prices floor at the protections', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 1,
        minPrice: 51_000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(5_100_000)

    clock.fireNext()
    await flush()

    const ioc = marketOrders()[0]!

    expect(ioc.price).toBe(5_100_000)
  })

  it('the slippage bound applies when it stays inside the protections', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
        maxSlippagePct: 1,
      }),
    )
    engine.start()
    await flush()

    clock.fireNext()
    await flush()

    const ioc = marketOrders()[0]!
    expect(ioc.price).toBe(5_050_000)
  })

  it('passive buy clamps the slice price to maxPrice', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        sliceCount: 1,
        isAsk: 0,
        maxPrice: 49_000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs).toHaveLength(2)
    expect(orderClient.inputs[0]!.price).toBe(4_900_000)
    expect(engine.getProgress().status).toBe('running')
  })

  it('neutral sell clamps the slice price to minPrice', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        sliceCount: 1,
        isAsk: 1,
        minPrice: 51_000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs).toHaveLength(2)
    expect(orderClient.inputs[0]!.price).toBe(5_100_000)
  })

  it('aggressive clamps to the bound BEFORE the reverse-penny tick adjust', async () => {
    const engine = makeEngine(makeConfig({ sliceCount: 1, isAsk: 0, maxPrice: 49_000 }))
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_899_999)
  })

  it('limit slices use the reference price when it is within bounds', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        sliceCount: 1,
        isAsk: 0,
        maxPrice: 60_000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_999_000)
  })

  it('buy slices cap at index × (1 + bps) when the style price is higher', async () => {
    marketData.indexPrice = 49_000
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        sliceCount: 1,
        isAsk: 0,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_904_900)
  })

  it('sell slices floor at index × (1 − bps) when the style price is lower', async () => {
    marketData.indexPrice = 51_000
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        sliceCount: 1,
        isAsk: 1,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(5_094_900)
  })

  it('aggressive applies the reverse-penny tick AFTER the wick clamp', async () => {
    marketData.indexPrice = 49_000
    const engine = makeEngine(
      makeConfig({ sliceCount: 1, isAsk: 0, maxIndexPriceDistancePercent: 0 }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_899_999)
  })

  it('the tighter of the absolute bound and the wick cap wins', async () => {
    marketData.indexPrice = 49_000

    let engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        sliceCount: 1,
        isAsk: 0,
        maxPrice: 48_000,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_800_000)

    reset()
    marketData.indexPrice = 49_000
    engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        sliceCount: 1,
        isAsk: 0,
        maxPrice: 49_500,
        maxIndexPriceDistancePercent: 0.1,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.price).toBe(4_904_900)
  })

  describe('index price band', () => {
    const BUY_CAP_UNITS = 5_050_000
    const SELL_FLOOR_UNITS = 4_950_000

    const runToEnd = async (engine: AdvancedTwapEngine) => {
      engine.start()
      await flush()
      while (clock.pendingCount() > 0) {
        clock.fireNext()
        await flush()
      }
    }

    const moveBook = (price: number) => {
      marketData.price = price
      marketData.bestBid = price
      marketData.bestAsk = price
    }

    const sentPrices = () => ({
      limit: orderClient.inputs.filter((i) => i.orderType === 0).map((i) => i.price),
      market: marketOrders().map((i) => i.price),
      modify: orderClient.modifyInputs.map((i) => i.price),
    })

    it.each(['aggressive', 'neutral', 'passive'] as const)(
      '%s buy: no limit, modify or market price goes above index × (1 + slippage) while the book runs away',
      async (executionStyle) => {
        moveBook(1_000_000)
        await runToEnd(
          makeEngine(
            makeConfig({
              executionStyle,
              totalSize: 100,
              sliceCount: 4,
              isAsk: 0,
            }),
          ),
        )

        const { limit, market, modify } = sentPrices()
        expect(limit.length).toBeGreaterThan(0)
        expect(market.length).toBeGreaterThan(0)
        expect(modify.length).toBeGreaterThan(0)
        for (const price of [...limit, ...market, ...modify]) {
          expect(price).toBeLessThanOrEqual(BUY_CAP_UNITS)
        }
        expect(market).toEqual(market.map(() => BUY_CAP_UNITS))
      },
    )

    it.each(['aggressive', 'neutral', 'passive'] as const)(
      '%s sell: no limit, modify or market price goes below index × (1 − slippage) while the book runs away',
      async (executionStyle) => {
        moveBook(1_000)
        await runToEnd(
          makeEngine(
            makeConfig({
              executionStyle,
              totalSize: 100,
              sliceCount: 4,
              isAsk: 1,
            }),
          ),
        )

        const { limit, market, modify } = sentPrices()
        expect(limit.length).toBeGreaterThan(0)
        expect(market.length).toBeGreaterThan(0)
        expect(modify.length).toBeGreaterThan(0)
        for (const price of [...limit, ...market, ...modify]) {
          expect(price).toBeGreaterThanOrEqual(SELL_FLOOR_UNITS)
        }
        expect(market).toEqual(market.map(() => SELL_FLOOR_UNITS))
      },
    )

    it('aggressive buy prices exactly at the band edge once the book is past it', async () => {
      moveBook(60_000)
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()

      expect(orderClient.inputs[0]).toMatchObject({
        orderType: 0,
        price: BUY_CAP_UNITS - 1,
      })
      expect(marketOrders()[0]!.price).toBe(BUY_CAP_UNITS)
    })

    it('aggressive sell prices exactly at the band edge once the book is past it', async () => {
      moveBook(40_000)
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 1 }))
      engine.start()
      await flush()

      expect(orderClient.inputs[0]).toMatchObject({
        orderType: 0,
        price: SELL_FLOOR_UNITS + 1,
      })
      expect(marketOrders()[0]!.price).toBe(SELL_FLOOR_UNITS)
    })

    it('the resting order is repriced onto the band, never onto the runaway book', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      expect(orderClient.inputs[0]!.price).toBe(5_000_999)

      moveBook(1_000_000)
      clock.fireNext()
      await flush()

      expect(orderClient.modifyInputs.at(-1)!.price).toBe(BUY_CAP_UNITS - 1)
    })

    it('the band follows the index as it moves', async () => {
      moveBook(1_000_000)
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      expect(marketOrders().at(-1)!.price).toBe(BUY_CAP_UNITS)

      marketData.indexPrice = 52_000
      clock.fireNext()
      await flush()

      expect(orderClient.modifyInputs.at(-1)!.price).toBe(5_251_999)
      expect(marketOrders().at(-1)!.price).toBe(5_252_000)
    })

    it('prices inside the band are left alone', async () => {
      marketData.indexPrice = 51_000
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()

      expect(orderClient.inputs[0]!.price).toBe(5_000_999)
      expect(marketOrders()[0]!.price).toBe(5_051_010)
    })

    it('a tighter wick protection still wins over the band', async () => {
      moveBook(1_000_000)
      const engine = makeEngine(
        makeConfig({
          totalSize: 100,
          sliceCount: 4,
          isAsk: 0,
          maxIndexPriceDistancePercent: 0.5,
        }),
      )
      engine.start()
      await flush()

      expect(orderClient.inputs[0]!.price).toBe(5_024_999)
      expect(marketOrders()[0]!.price).toBe(5_025_000)
    })

    it('a looser wick protection cannot widen the band', async () => {
      moveBook(1_000_000)
      const engine = makeEngine(
        makeConfig({
          totalSize: 100,
          sliceCount: 4,
          isAsk: 0,
          maxIndexPriceDistancePercent: 10,
        }),
      )
      engine.start()
      await flush()

      expect(orderClient.inputs[0]!.price).toBe(BUY_CAP_UNITS - 1)
      expect(marketOrders()[0]!.price).toBe(BUY_CAP_UNITS)
    })

    it.each(['aggressive', 'neutral', 'passive'] as const)(
      '%s: a missing index sends nothing and fails the slice',
      async (executionStyle) => {
        marketData.indexPrice = null
        const engine = makeEngine(
          makeConfig({
            executionStyle,
            totalSize: 100,
            sliceCount: 4,
            isAsk: 0,
          }),
        )
        engine.start()
        await flush()

        expect(orderClient.inputs).toHaveLength(0)
        expect(engine.getProgress().failedBaseAmount).toBe(25)
        expect(engine.getProgress().status).toBe('running')
      },
    )

    it('a missing index never reprices the resting order', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      const submits = orderClient.inputs.length

      marketData.indexPrice = null
      moveBook(1_000_000)
      clock.fireNext()
      await flush()

      expect(orderClient.modifyInputs).toHaveLength(0)
      expect(orderClient.inputs).toHaveLength(submits)
    })

    it('a market part sent after the index drops mid-slice is failed, not sent at the stale price', async () => {
      orderClient.autoResolve = null
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      expect(orderClient.pending).toHaveLength(1)
      expect(orderClient.pending[0]!.input.orderType).toBe(0)

      marketData.indexPrice = null
      orderClient.autoResolve = {}
      orderClient.pending.shift()!.resolve({})
      await flush()

      expect(marketOrders()).toHaveLength(0)
      expect(engine.getProgress().failedBaseAmount).toBe(24)
      expect(engine.getProgress().status).toBe('running')
    })

    it('a market part sent after a modify while the index is gone is failed, not sent', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      const marketsBefore = marketOrders().length
      const failedBefore = engine.getProgress().failedBaseAmount

      orderClient.modifyDefer = true
      clock.fireNext()
      await flush()
      expect(orderClient.pendingModifies).toHaveLength(1)

      marketData.indexPrice = null
      orderClient.pendingModifies.shift()!.resolve({})
      await flush()

      expect(marketOrders()).toHaveLength(marketsBefore)
      expect(engine.getProgress().failedBaseAmount).toBeGreaterThan(failedBefore)
    })

    it('a slice too small to rest goes out as a market order capped at the band', async () => {
      marketData.market = { ...MARKET, min_base_amount: '2' }
      moveBook(1_000_000)
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()

      expect(orderClient.inputs).toHaveLength(1)
      expect(orderClient.inputs[0]).toMatchObject({
        orderType: 1,
        price: BUY_CAP_UNITS,
      })
    })

    it('the final boundary without an index cancels the resting order and sends nothing', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      for (let i = 0; i < 3; i++) {
        clock.fireNext()
        await flush()
      }
      const submits = orderClient.inputs.length
      const modifies = orderClient.modifyInputs.length

      marketData.indexPrice = null
      moveBook(1_000_000)
      clock.fireNext()
      await flush()

      expect(orderClient.inputs).toHaveLength(submits)
      expect(orderClient.modifyInputs).toHaveLength(modifies)
      expect(orderClient.cancelInputs).toHaveLength(1)
      expect(engine.getProgress().status).toBe('completed')
    })

    it('the final boundary sweeps the remainder inside the band', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      for (let i = 0; i < 3; i++) {
        clock.fireNext()
        await flush()
      }
      const marketsBefore = marketOrders().length

      moveBook(1_000_000)
      clock.fireNext()
      await flush()

      expect(marketOrders().length).toBeGreaterThan(marketsBefore)
      expect(marketOrders().at(-1)!.price).toBe(BUY_CAP_UNITS)
      for (const { price } of orderClient.modifyInputs) {
        expect(price).toBeLessThanOrEqual(BUY_CAP_UNITS)
      }
    })

    it('a replacement posted after a terminal modify is priced against the index at that moment', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      const limitsBefore = orderClient.inputs.filter((i) => i.orderType === 0).length

      const modify = orderClient.modifyOrder.bind(orderClient)
      orderClient.modifyOrder = (input) => {
        marketData.indexPrice = 47_000
        return modify(input)
      }
      orderClient.autoModifyResolve = {
        order: wsOrder({ order_id: 'auto', status: 'canceled' })[0],
      }
      clock.fireNext()
      await flush()

      const replacement = orderClient.inputs.filter((i) => i.orderType === 0).slice(limitsBefore)
      expect(orderClient.modifyInputs).toHaveLength(1)
      expect(replacement).toHaveLength(1)
      expect(replacement[0]!.price).toBe(4_746_999)
      expect(marketOrders().at(-1)!.price).toBe(4_747_000)
    })

    it('a replacement re-capped below the venue minimum goes out as a protected market order', async () => {
      marketData.market = { ...MARKET, min_quote_amount: '10' }
      const engine = makeEngine(makeConfig({ totalSize: 0.022, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      const submitsBefore = orderClient.inputs.length

      const modify = orderClient.modifyOrder.bind(orderClient)
      orderClient.modifyOrder = (input) => {
        marketData.indexPrice = 47_000
        return modify(input)
      }
      orderClient.autoModifyResolve = {
        order: wsOrder({ order_id: 'auto', status: 'canceled' })[0],
      }
      clock.fireNext()
      await flush()

      const replacement = orderClient.inputs.slice(submitsBefore)
      expect(replacement.length).toBeGreaterThan(0)
      expect(replacement.filter((i) => i.orderType === 0)).toHaveLength(0)
      for (const order of replacement) {
        expect(order.orderType).toBe(1)
        expect(order.price).toBe(4_747_000)
      }
      expect(replacement.reduce((sum, i) => sum + i.baseAmount, 0)).toBe(550)
    })

    it('a sell replacement after a terminal modify is floored against the index at that moment', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 1 }))
      engine.start()
      await flush()
      const limitsBefore = orderClient.inputs.filter((i) => i.orderType === 0).length

      const modify = orderClient.modifyOrder.bind(orderClient)
      orderClient.modifyOrder = (input) => {
        marketData.indexPrice = 53_000
        return modify(input)
      }
      orderClient.autoModifyResolve = {
        order: wsOrder({ order_id: 'auto', status: 'canceled' })[0],
      }
      clock.fireNext()
      await flush()

      const replacement = orderClient.inputs.filter((i) => i.orderType === 0).slice(limitsBefore)
      expect(replacement).toHaveLength(1)
      expect(replacement[0]!.price).toBe(5_247_001)
      expect(marketOrders().at(-1)!.price).toBe(5_247_000)
    })

    it('the final sweep after the working order is retired is priced against the index at that moment', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      for (let i = 0; i < 3; i++) {
        clock.fireNext()
        await flush()
      }
      const submitsBefore = orderClient.inputs.length

      const cancel = orderClient.cancelOrder.bind(orderClient)
      orderClient.cancelOrder = (input) => {
        marketData.indexPrice = 47_000
        return cancel(input)
      }
      clock.fireNext()
      await flush()

      const sweep = orderClient.inputs.slice(submitsBefore)
      expect(orderClient.cancelInputs).toHaveLength(1)
      expect(sweep.length).toBeGreaterThan(0)
      for (const { price } of sweep) {
        expect(price).toBeLessThanOrEqual(4_747_000)
      }
    })

    it('no replacement is posted when the index drops out during a terminal modify', async () => {
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 4, isAsk: 0 }))
      engine.start()
      await flush()
      const submitsBefore = orderClient.inputs.length

      const modify = orderClient.modifyOrder.bind(orderClient)
      orderClient.modifyOrder = (input) => {
        marketData.indexPrice = null
        return modify(input)
      }
      orderClient.autoModifyResolve = {
        order: wsOrder({ order_id: 'auto', status: 'canceled' })[0],
      }
      const failedBefore = engine.getProgress().failedBaseAmount
      clock.fireNext()
      await flush()

      expect(orderClient.inputs).toHaveLength(submitsBefore)
      expect(engine.getProgress().failedBaseAmount).toBe(failedBefore + 25)
      expect(engine.getProgress().status).toBe('running')
    })

    it('a book that runs away for a while and comes back never trips the order guard', async () => {
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
      const engine = makeEngine(makeConfig({ totalSize: 100, sliceCount: 6, isAsk: 0 }))

      moveBook(49_900)
      engine.start()
      await flush()
      const sentBeforeRunaway = marketOrders().length
      for (let i = 0; i < 2; i++) {
        moveBook(1_000_000)
        clock.fireNext()
        await flush()
      }
      const marketDuringRunaway = marketOrders()
        .slice(sentBeforeRunaway)
        .map((i) => i.price)
      moveBook(49_900)
      while (clock.pendingCount() > 0) {
        clock.fireNext()
        await flush()
      }

      expect(status('aborted')).toBeUndefined()
      expect(engine.getProgress().status).toBe('completed')
      expect(marketDuringRunaway.length).toBeGreaterThan(0)
      expect(marketDuringRunaway).toEqual(marketDuringRunaway.map(() => BUY_CAP_UNITS))
      expect(marketOrders().at(-1)!.price).toBe(5_039_900)
      expect(orderClient.modifyInputs.at(-1)!.price).toBe(4_989_999)
    })

    it('caps every slice at the index bound when the book runs away', async () => {
      marketData.market = {
        ...MARKET,
        market_id: 1,
        min_base_amount: '0.0050',
        min_quote_amount: '10.000000',
      }
      marketData.indexPrice = 2_400
      const asksSeenBySlice = [
        2_406.69, 2_406.69, 2_407.82, 2_409.25, 2_412.03, 2_413.97, 2_419.35, 2_487, 2_488.61,
        2_677.47, 3_000, 3_000.75, 3_001.87, 3_026.14, 3_029.58, 3_090.15, 3_096.37, 3_113.07,
        3_115.54, 3_888.08, 5_000, 6_300, 6_300, 6_300, 6_302.36, 20_000, 20_007.5, 6_301.83,
        6_304.18, 6_304.98, 9_450, 9_452.36, 14_960, 14_965.6, 20_007.4, 71_000, 2_560.82, 2_429.5,
        2_427.98, 2_990,
      ]
      const engine = makeEngine(
        makeConfig({
          totalSize: 2_000,
          sliceCount: asksSeenBySlice.length,
          baseIntervalMs: 4_000,
          isAsk: 0,
          maxSlippagePct: 3,
        }),
      )

      moveBook(asksSeenBySlice[0]!)
      engine.start()
      await flush()
      for (const ask of asksSeenBySlice.slice(1)) {
        moveBook(ask)
        clock.fireNext()
        await flush()
      }
      while (clock.pendingCount() > 0) {
        clock.fireNext()
        await flush()
      }

      const { limit, market, modify } = sentPrices()
      expect(limit[0]).toBe(240_668)
      expect(modify.length).toBeGreaterThan(30)
      expect(market.length).toBeGreaterThan(30)
      expect(modify).not.toContain(2_000_749)
      expect(modify).not.toContain(7_099_999)
      for (const price of [...limit, ...modify]) {
        expect(price).toBeLessThanOrEqual(247_199)
      }
      for (const price of market) {
        expect(price).toBeLessThanOrEqual(247_200)
      }
      expect(Math.max(...market)).toBe(247_200)
    })
  })

  it('one operation at a time: a slow boundary defers, never overlaps, the next', async () => {
    orderClient.autoResolve = null
    const engine = makeEngine(makeConfig({ sliceCount: 3, baseIntervalMs: 1000 }))
    engine.start()
    await flush()
    expect(orderClient.pending).toHaveLength(1)

    expect(clock.pendingCount()).toBe(0)

    clock.advance(2_500)
    orderClient.autoResolve = {}
    orderClient.pending.shift()!.resolve({})
    await flush()

    expect(clock.pendingCount()).toBe(1)
    expect(clock.nextDueAt()).toBe(2_500)
    clock.fireNext()
    await flush()

    await flush()

    expect(clock.nextDueAt()).toBe(3_000)
  })

  it('stopping mid-RPC lets the slice finish, then cancels what it rested', async () => {
    orderClient.autoResolve = null
    const engine = makeEngine()
    engine.start()
    await flush()
    expect(orderClient.pending).toHaveLength(1)

    engine.stop('mid-rpc abort')
    expect(status('aborted')).toBeDefined()

    orderClient.pending[0]!.resolve({
      order: wsOrder({ order_id: 'late', initial_base_amount: 0.00033 })[0],
    })
    await flush()

    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(orderClient.cancelInputs[0]!.orderId).toBe('late')
    expect(clock.pendingCount()).toBe(0)
    expect(engine.getProgress().status).toBe('aborted')
  })

  it('stopping mid-RPC on the throw path does not resurrect the boundary', async () => {
    orderClient.autoResolve = null
    const engine = makeEngine()
    engine.start()
    await flush()

    engine.stop('mid-rpc abort')
    orderClient.pending[0]!.reject(new Error('network blip'))
    await flush()

    const aborts = events.filter((e) => e.type === 'status' && e.status === 'aborted')
    expect(aborts).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })

  it('stop() is a no-op once completed', async () => {
    const engine = makeEngine(makeConfig({ sliceCount: 1 }))
    engine.start()
    await flush()
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'filled',
        filled_base_amount: 0.00001,
      })[0],
    })
    expect(status('completed')).toBeDefined()
    const before = events.length
    engine.stop()
    expect(events.length).toBe(before)
  })

  it('stop() is a no-op once aborted', () => {
    const engine = makeEngine(makeConfig({ marketId: 999 }))
    const before = events.length
    engine.stop()
    engine.stop()
    expect(events.length).toBe(before)
  })

  it('fills track the WS truth for resting slices', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'open',
        filled_base_amount: 0.0004,
      })[0],
    })
    expect(engine.getProgress().filledBaseAmount).toBe(0.0004)
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'open',
        filled_base_amount: 0.0007,
      })[0],
    })
    expect(engine.getProgress().filledBaseAmount).toBe(0.0007)
  })

  it('completes early (no cancel) when WS fills reach the total', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'filled',
        filled_base_amount: 0.00005,
      })[0],
    })
    expect(status('completed')).toBeDefined()
    expect(orderClient.cancelInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(0)
  })

  it('abort cancels the resting limit slice', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 2 }))
    engine.start()
    await flush()

    engine.stop('user cancelled')
    expect(status('aborted')).toBeDefined()
    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(orderClient.cancelInputs[0]!.orderId).toBe('auto')
  })

  it('final boundary retires the resting order BEFORE the completion market IOC', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)

    clock.fireNext()
    await flush()
    expect(orderClient.modifyInputs).toHaveLength(0)
    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(orderClient.cancelInputs[0]!.orderId).toBe('auto')

    const completion = orderClient.inputs.at(-1)!
    expect(completion.orderType).toBe(1)
    expect(completion.timeInForce).toBe(0)
    expect(completion.baseAmount).toBe(5)
    expect(status('completed')).toBeDefined()

    expect(engine.getProgress().filledBaseAmount).toBe(0)
  })

  it('the final shrink’s confirmed fill shrinks the completion order', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'open',
        filled_base_amount: 0.00002,
      })[0],
    })

    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'auto',
        status: 'canceled',
        filled_base_amount: 0.00002,
      })[0],
    }
    clock.fireNext()
    await flush()

    const completion = orderClient.inputs.at(-1)!
    expect(completion.orderType).toBe(1)
    expect(completion.baseAmount).toBe(3)
    expect(status('completed')).toBeDefined()
  })

  it('no completion order when the final shrink loses to a full fill', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'open',
        filled_base_amount: 0.00002,
      })[0],
    })

    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'auto',
        status: 'filled',
        filled_base_amount: 0.00005,
      })[0],
    }
    clock.fireNext()
    await flush()

    expect(marketOrders()).toHaveLength(1)
    expect(status('completed')).toBeDefined()
    expect(engine.getProgress().filledBaseAmount).toBe(0.00005)
  })

  it('cancels instead of shrinking when the shrunk size is below the venue minimum', async () => {
    marketData.market = { ...MARKET, min_base_amount: '0.00001' }
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()

    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(0)
    expect(orderClient.cancelInputs).toHaveLength(1)
    expect(orderClient.cancelInputs[0]!.orderId).toBe('auto')

    const completion = orderClient.inputs.at(-1)!
    expect(completion.orderType).toBe(1)
    expect(completion.baseAmount).toBe(5)
    expect(status('completed')).toBeDefined()
  })

  it('a below-minimum slice front-runs later slots into one immediate order', async () => {
    marketData.market = { ...MARKET, min_base_amount: '2.5' }
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        totalSize: 100,
        sliceCount: 100,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.orderType).not.toBe(1)
    expect(orderClient.inputs[0]!.baseAmount).toBeGreaterThanOrEqual(2.5 * 1e5)
    expect(engine.getProgress().failedBaseAmount).toBe(0)

    // The consumed future slots are executed, so the next boundary is armed
    // beyond them rather than at the regular first interval.
    expect(engine.getProgress().consumedSlices).toBe(3)
    expect(clock.nextDueAt()!).toBeGreaterThan(1000)
  })

  it('markets the remainder when the schedule runs out below the minimum', async () => {
    marketData.market = { ...MARKET, min_base_amount: '50' }
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'neutral',
        totalSize: 10,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.orderType).toBe(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
  })

  it('a below-minimum delta still grows an existing working order via modify', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs).toHaveLength(1)

    marketData.market = { ...MARKET, min_base_amount: '6' }
    clock.fireNext()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(orderClient.inputs).toHaveLength(1)
    expect(clock.nextDueAt()).toBe(2000)
  })

  it('a sub-minimum market part dispatches as-is when the order is at cap', async () => {
    marketData.market = { ...MARKET, min_base_amount: '6' }
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()

    // The fresh post already front-runs slot 2, resting at the 10% cap.
    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(engine.getProgress().consumedSlices).toBe(2)

    orderClient.autoResolve = {
      order: wsOrder({
        order_id: 'ioc',
        status: 'filled',
        initial_base_amount: 5,
        filled_base_amount: 5,
        filled_quote_amount: 5 * 50_000,
      })[0],
    }
    clock.fireNext()
    await flush()

    // Slot 3's market part (5) is below the minimum, but IOC orders are
    // exempt from the venue minimum so it dispatches as-is.
    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.modifyInputs[0]!.baseAmount).toBe(10 * 1e5)
    const market = orderClient.inputs.at(-1)!
    expect(market.orderType).toBe(1)
    expect(market.baseAmount).toBe(5 * 1e5)
    expect(engine.getProgress().consumedSlices).toBe(3)
    expect(engine.getProgress().failedBaseAmount).toBe(0)
    expect(engine.getProgress().filledBaseAmount).toBe(5)
    expect(clock.nextDueAt()).toBe(3000)
  })

  it('a partially applied grow that fills re-posts only the unapplied part', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 20,
        baseIntervalMs: 1000,
      }),
    )
    engine.start()
    await flush()
    expect(orderClient.inputs[0]!.baseAmount).toBe(5 * 1e5)

    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'auto',
        status: 'filled',
        initial_base_amount: 8,
        filled_base_amount: 8,
        filled_quote_amount: 8 * 50_000,
      })[0],
    }
    clock.fireNext()
    await flush()

    expect(engine.getProgress().filledBaseAmount).toBe(8)
    expect(orderClient.inputs).toHaveLength(2)
    expect(orderClient.inputs[1]!.baseAmount).toBe(2 * 1e5)
  })

  it('a thrown fresh limit submit marks the amount failed with no market fallback', async () => {
    orderClient.autoReject = new Error('maybe landed')
    const engine = makeEngine(makeConfig({ executionStyle: 'passive', sliceCount: 10 }))
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.orderType).not.toBe(1)
    expect(engine.getProgress().failedBaseAmount).toBeGreaterThan(0)
  })

  it('a thrown market submit marks the amount failed', async () => {
    orderClient.autoReject = new Error('maybe landed')
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'aggressive',
        totalSize: 100,
        sliceCount: 4,
        isAsk: 0,
      }),
    )
    engine.start()
    await flush()

    // Aggressive tolerance (1%) is below the 25% slice: limit part + market
    // excess both throw and both land in failed.
    expect(engine.getProgress().failedBaseAmount).toBe(25)
  })

  it('a failed final shrink leaves the order up without a blind market order', async () => {
    const engine = makeEngine(makeConfig({ executionStyle: 'neutral', sliceCount: 1 }))
    engine.start()
    await flush()
    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'open',
        filled_base_amount: 0.00002,
      })[0],
    })

    orderClient.modifyReject = new Error('order already filled')
    clock.fireNext()
    await flush()
    expect(orderClient.cancelInputs).toHaveLength(0)
    expect(marketOrders()).toHaveLength(1)
    expect(status('completed')).toBeUndefined()
    expect(Object.keys(engine.getWorkingOrders())).toEqual(['auto'])
    expect(engine.getProgress().failedBaseAmount).toBe(0.00095)
  })

  describe('final boundary with a working order that does not retire', () => {
    const FINAL_CONFIG = makeConfig({
      executionStyle: 'passive',
      totalSize: 100,
      sliceCount: 4,
      baseIntervalMs: 1000,
    })

    it('retries the cancel instead of completing while the order is still open', async () => {
      clock.advance(5000)
      const engine = makeEngine(
        FINAL_CONFIG,
        0,
        resumeState({
          filledBaseAmount: 90,
          consumedSlices: 4,
          workingOrders: wsWorkingOrders({
            order_id: 'resumed-1',
            initial_base_amount: 10,
            filled_base_amount: 0,
          }),
        }),
      )
      orderClient.cancelReject = new Error('cancel timed out')
      engine.start()
      await flush()

      expect(orderClient.cancelInputs).toHaveLength(1)
      expect(orderClient.inputs).toHaveLength(0)
      expect(status('completed')).toBeUndefined()
      expect(Object.keys(engine.getWorkingOrders())).toEqual(['resumed-1'])
      expect(engine.getProgress().nextActionAt).toBe(5000 + 10_000)

      orderClient.cancelReject = null
      orderClient.autoCancelResolve = {
        order: wsOrder({
          order_id: 'resumed-1',
          status: 'canceled',
          initial_base_amount: 10,
          filled_base_amount: 0,
        })[0],
      }
      orderClient.autoResolve = {
        order: wsOrder({
          order_id: 'ioc-1',
          status: 'filled',
          type: 'market',
          initial_base_amount: 10,
          filled_base_amount: 10,
          filled_quote_amount: 10 * 50_000,
        })[0],
      }
      clock.fireNext()
      await flush()

      expect(orderClient.cancelInputs).toHaveLength(2)
      expect(engine.getWorkingOrders()).toEqual({})
      expect(marketOrders()).toHaveLength(1)
      expect(marketOrders()[0]!.baseAmount).toBe(10 * 1e5)
      expect(status('completed')).toBeDefined()
      expect(engine.getProgress().filledBaseAmount).toBe(100)
      expect(engine.getProgress().failedBaseAmount).toBe(0)
    })

    it('retries the shrink instead of completing while the order is still open', async () => {
      clock.advance(5000)
      const engine = makeEngine(
        FINAL_CONFIG,
        0,
        resumeState({
          filledBaseAmount: 90,
          consumedSlices: 4,
          workingOrders: wsWorkingOrders({
            order_id: 'resumed-1',
            initial_base_amount: 50,
            filled_base_amount: 40,
            filled_quote_amount: 40 * 50_000,
          }),
        }),
      )
      orderClient.modifyReject = new Error('modify timed out')
      engine.start()
      await flush()

      expect(orderClient.modifyInputs).toHaveLength(1)
      expect(orderClient.modifyInputs[0]!.baseAmount).toBe(40 * 1e5)
      expect(marketOrders()).toHaveLength(0)
      expect(status('completed')).toBeUndefined()
      expect(Object.keys(engine.getWorkingOrders())).toEqual(['resumed-1'])

      orderClient.modifyReject = null
      orderClient.autoModifyResolve = {
        order: wsOrder({
          order_id: 'resumed-1',
          status: 'filled',
          initial_base_amount: 40,
          filled_base_amount: 40,
          filled_quote_amount: 40 * 50_000,
        })[0],
      }
      orderClient.autoResolve = {
        order: wsOrder({
          order_id: 'ioc-1',
          status: 'filled',
          type: 'market',
          initial_base_amount: 10,
          filled_base_amount: 10,
          filled_quote_amount: 10 * 50_000,
        })[0],
      }
      clock.fireNext()
      await flush()

      expect(orderClient.modifyInputs).toHaveLength(2)
      expect(engine.getWorkingOrders()).toEqual({})
      expect(marketOrders()).toHaveLength(1)
      expect(marketOrders()[0]!.baseAmount).toBe(10 * 1e5)
      expect(status('completed')).toBeDefined()
      expect(engine.getProgress().filledBaseAmount).toBe(100)
    })
  })

  it('completes the full remainder after price returns inside the bound', async () => {
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        sliceCount: 1,
        baseIntervalMs: 1000,
        isAsk: 0,
        maxPrice: 49_000,
      }),
    )
    engine.start()
    await flush()

    marketData.price = 48_900
    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'auto',
        status: 'canceled',
        initial_base_amount: 0.0001,
      })[0],
    }
    clock.fireNext()
    await flush()

    expect(marketOrders()).toHaveLength(2)
    expect(marketOrders().at(-1)!.baseAmount).toBe(10)
    expect(status('completed')).toBeDefined()
  })

  it('resume: slice sizes come from the schedule, not the remaining', async () => {
    clock.advance(2000)
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
      0,
      resumeState({ filledBaseAmount: 50, consumedSlices: 2 }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
    expect(status('completed')).toBeUndefined()
  })

  it('resume: re-adopts a still-resting working order and reprices it', async () => {
    clock.advance(2000)
    const engine = makeEngine(
      makeConfig({ totalSize: 100, sliceCount: 4, baseIntervalMs: 1000 }),
      2000,
      resumeState({
        filledBaseAmount: 10,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 10,
          filled_quote_amount: 10 * 50_000,
          initial_base_amount: 25,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.modifyInputs).toMatchObject([{ orderId: 'resumed-1' }])
  })

  it('resume: the re-adopted order does not shrink the remaining slices', async () => {
    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'resumed-1',
        status: 'filled',
        filled_base_amount: 10,
        filled_quote_amount: 10 * 50_000,
        initial_base_amount: 10,
      })[0],
    }
    const engine = makeEngine(
      makeConfig({
        executionStyle: 'passive',
        totalSize: 100,
        sliceCount: 10,
        baseIntervalMs: 1000,
      }),
      0,
      resumeState({
        filledBaseAmount: 30,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 10,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(orderClient.inputs).toHaveLength(1)
    expect(orderClient.inputs[0]!.baseAmount).toBe(10 * 1e5)
  })

  it('reduce-only: aborts when a slice is canceled-reduce-only by the venue', async () => {
    orderClient.autoResolve = {
      order: wsOrder({ status: 'canceled-reduce-only' })[0],
    }
    const engine = makeEngine(makeConfig({ reduceOnly: true }))
    engine.start()
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(status('aborted')?.reason).toBe(REDUCE_ONLY_EXHAUSTED_REASON)

    expect(orderClient.inputs).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })

  it('reduce-only: aborts when the working order streams canceled-reduce-only', async () => {
    const engine = makeEngine(makeConfig({ reduceOnly: true }))
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'auto',
        status: 'canceled-reduce-only',
        filled_base_amount: 0.0002,
        filled_quote_amount: 0.0002 * 50_000,
      })[0],
    })

    expect(status('completed')).toBeUndefined()
    expect(status('aborted')?.reason).toBe(REDUCE_ONLY_EXHAUSTED_REASON)

    const progress = events
      .filter((e): e is Extract<EngineEvent, { type: 'progress' }> => e.type === 'progress')
      .at(-1)!.progress
    expect(progress.filledBaseAmount).toBe(0.0002)
  })

  it('reduce-only: aborts when the modify resolves canceled-reduce-only', async () => {
    orderClient.autoModifyResolve = {
      order: wsOrder({
        order_id: 'resumed-1',
        status: 'canceled-reduce-only',
      })[0],
    }
    const engine = makeEngine(
      makeConfig({ reduceOnly: true, totalSize: 100, sliceCount: 4 }),
      0,
      resumeState({
        filledBaseAmount: 25,
        workingOrders: wsWorkingOrders({
          order_id: 'resumed-1',
          filled_base_amount: 0,
          initial_base_amount: 25,
        }),
      }),
    )
    engine.start()
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(status('aborted')?.reason).toBe(REDUCE_ONLY_EXHAUSTED_REASON)

    expect(orderClient.inputs).toHaveLength(0)
  })

  it('a canceled-reduce-only slice does not complete a non-reduce-only strategy', async () => {
    orderClient.autoResolve = {
      order: wsOrder({ status: 'canceled-reduce-only' })[0],
    }
    const engine = makeEngine(makeConfig({ reduceOnly: false }))
    engine.start()
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)
  })

  it('on() returns an unsubscribe that stops further events', () => {
    const local: EngineEvent[] = []
    const engine = new AdvancedTwapEngine(
      makeConfig(),
      { marketData, orderClient, clock, createdAt: 0 },
      () => {},
    )
    const off = engine.on((e) => local.push(e))
    engine.start()
    expect(local.length).toBeGreaterThan(0)
    off()
    const before = local.length
    engine.stop()
    expect(local.length).toBe(before)
  })
})
