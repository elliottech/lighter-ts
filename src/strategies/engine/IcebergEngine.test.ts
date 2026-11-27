import { ApiError, type Order } from '../..'
import {
  type CancelInput,
  type CancelResult,
  ENGINE_ORDER_TYPE,
  type EngineEvent,
  type IcebergConfig,
  type IcebergResumeState,
  type MarketDataSource,
  type MarketMeta,
  type ModifyOrderInput,
  type ModifyResult,
  type OrderClient,
  type SubmitOrderInput,
  type SubmitResult,
} from './types'
import { OrderPriceGuardError, REDUCE_ONLY_EXHAUSTED_REASON } from './errors'
import { assertOrderPriceNearIndex } from './planner'
import { beforeEach, describe, expect, it } from 'vitest'

import { IcebergEngine } from './IcebergEngine'
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
  indexPrice: number | null = 100
  bestBidPrice: number | null = 100
  bestAskPrice: number | null = 100.5

  getMarket() {
    return MARKET
  }

  getIndexPrice(): number | null {
    return this.indexPrice
  }

  getMarkPrice(): number | null {
    return 100
  }

  getMidPrice(): number | null {
    return 100
  }

  getBestBidPrice(): number | null {
    return this.bestBidPrice
  }

  getBestAskPrice(): number | null {
    return this.bestAskPrice
  }
}

class FakeOrderClient implements OrderClient {
  submitInputs: SubmitOrderInput[] = []
  modifyInputs: ModifyOrderInput[] = []
  cancelInputs: CancelInput[] = []
  submitError: Error | null = null
  modifyError: Error | null = null
  /** When true, cancels stay pending like a venue cancel awaiting ws confirmation. */
  cancelDefer = false
  /** Final fill state the ws-confirmed cancel reports, keyed by order id. */
  cancelFills: Record<string, Partial<Order>> = {}

  submitOrder(input: SubmitOrderInput): Promise<SubmitResult> {
    this.submitInputs.push(input)
    if (this.submitError) {
      return Promise.reject(this.submitError)
    }
    return Promise.resolve({
      order: wsOrder({
        order_id: `order-${this.submitInputs.length}`,
        price: input.price / 10 ** MARKET.price_decimals,
        initial_base_amount: input.baseAmount / 10 ** MARKET.size_decimals,
        status: input.orderType === ENGINE_ORDER_TYPE.market ? 'filled' : 'open',
      })[0],
    })
  }

  modifyOrder(input: ModifyOrderInput): Promise<ModifyResult> {
    this.modifyInputs.push(input)
    if (this.modifyError) {
      return Promise.reject(this.modifyError)
    }
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
    if (this.cancelDefer) {
      return new Promise(() => {})
    }
    return Promise.resolve({
      order: wsOrder({
        order_id: input.orderId,
        client_order_index: input.clientOrderIndex,
        status: 'canceled',
        ...this.cancelFills[input.orderId],
      })[0],
    })
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const makeConfig = (overrides: Partial<IcebergConfig> = {}): IcebergConfig => ({
  accountIndex: 3,
  marketId: 0,
  isAsk: 0,
  totalSize: 100,
  reduceOnly: false,
  postOnly: true,
  restingChunkBaseAmount: 10,
  repriceIntervalMs: 1000,
  limitPrice: 200,
  maxRestingOrders: 2,
  ...overrides,
})

describe('IcebergEngine', () => {
  let clock: FakeClock
  let orderClient: FakeOrderClient
  let events: EngineEvent[]

  beforeEach(() => {
    clock = new FakeClock()
    orderClient = new FakeOrderClient()
    events = []
  })

  const makeEngine = (config: IcebergConfig, resume?: IcebergResumeState) =>
    new IcebergEngine(
      config,
      { marketData: new FakeMarketData(), orderClient, clock },
      (event) => events.push(event),
      resume,
    )

  const status = (value: 'running' | 'completed' | 'aborted') =>
    events.find(
      (event): event is Extract<EngineEvent, { type: 'status' }> =>
        event.type === 'status' && event.status === value,
    )

  it('places no top-up order after a rejected reprice aborts the strategy', async () => {
    orderClient.cancelDefer = true
    orderClient.modifyError = new ApiError('not enough margin to create the order', 21739)
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 5,
      filledQuoteAmount: 5 * 99,
      makerBaseAmount: 5,
      workingOrders: wsWorkingOrders({
        order_id: 'resting-1',
        client_order_index: 11,
        status: 'open',
        price: 99,
        initial_base_amount: 10,
        filled_base_amount: 5,
        filled_quote_amount: 5 * 99,
        remaining_base_amount: 5,
      }),
    })
    engine.start()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(status('aborted')?.reason).toBe('not enough margin to create the order')
    expect(orderClient.cancelInputs.map((c) => c.orderId)).toEqual(['resting-1'])
    expect(orderClient.submitInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(0)
  })

  const lastProgress = () =>
    events
      .filter((e): e is Extract<EngineEvent, { type: 'progress' }> => e.type === 'progress')
      .at(-1)!.progress

  const removedOrderIds = () =>
    events
      .filter(
        (e): e is Extract<EngineEvent, { type: 'removeWorkingOrder' }> =>
          e.type === 'removeWorkingOrder',
      )
      .map((e) => e.order.order_id)

  /** Two resting orders of 5 each: the 10 chunk is full, so a pass places nothing. */
  const twoRestingOrders = (): IcebergResumeState => ({
    filledBaseAmount: 2,
    filledQuoteAmount: 2 * 100,
    makerBaseAmount: 2,
    workingOrders: wsWorkingOrders(
      {
        order_id: 'resting-1',
        client_order_index: 11,
        status: 'open',
        price: 100,
        initial_base_amount: 5,
        filled_base_amount: 1,
        filled_quote_amount: 100,
        remaining_base_amount: 4,
      },
      {
        order_id: 'resting-2',
        client_order_index: 12,
        status: 'open',
        price: 100,
        initial_base_amount: 5,
        filled_base_amount: 1,
        filled_quote_amount: 100,
        remaining_base_amount: 4,
      },
    ),
  })

  it('throws on a second start() without dispatching again', async () => {
    const engine = makeEngine(makeConfig())
    engine.start()
    await flush()
    const sent = orderClient.submitInputs.length
    expect(sent).toBeGreaterThan(0)

    expect(() => engine.start()).toThrow('engine already started')
    await flush()
    expect(orderClient.submitInputs).toHaveLength(sent)
  })

  it('aborts with the guard reason when the order client refuses a chunk submit', async () => {
    orderClient.submitError = new OrderPriceGuardError(GUARD_REASON)
    const engine = makeEngine(makeConfig())
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(status('aborted')?.reason).toBe(GUARD_REASON)
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts with the guard reason when the order client refuses a reprice', async () => {
    orderClient.cancelDefer = true
    orderClient.modifyError = new OrderPriceGuardError(GUARD_REASON)
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 5,
      filledQuoteAmount: 5 * 99,
      makerBaseAmount: 5,
      workingOrders: wsWorkingOrders({
        order_id: 'resting-1',
        client_order_index: 11,
        status: 'open',
        price: 99,
        initial_base_amount: 10,
        filled_base_amount: 5,
        filled_quote_amount: 5 * 99,
        remaining_base_amount: 5,
      }),
    })
    engine.start()
    await flush()

    expect(orderClient.modifyInputs[0]).toMatchObject({ isAsk: 0 })
    expect(status('aborted')?.reason).toBe(GUARD_REASON)
    expect(orderClient.submitInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(0)
  })

  it('aborts with the exchange message when a chunk submit is rejected as non-retryable', async () => {
    orderClient.submitError = new ApiError('not enough margin to create the order', 21739)
    const engine = makeEngine(makeConfig())
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(status('aborted')?.reason).toBe('not enough margin to create the order')
    expect(clock.pendingCount()).toBe(0)
  })

  it('keeps running and retries later when a chunk submit fails for another reason', async () => {
    orderClient.submitError = new Error('network error')
    const engine = makeEngine(makeConfig())
    engine.start()
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)
  })

  it('waits for the other resting chunk before taking out a tail below the venue minimum', async () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 94.5,
      filledQuoteAmount: 94.5 * 100,
      makerBaseAmount: 94.5,
      workingOrders: wsWorkingOrders(
        {
          order_id: 'resting-1',
          client_order_index: 11,
          status: 'open',
          price: 100,
          initial_base_amount: 5,
          remaining_base_amount: 5,
        },
        {
          order_id: 'resting-2',
          client_order_index: 12,
          status: 'open',
          price: 100,
          initial_base_amount: 5,
          filled_base_amount: 4.5,
          filled_quote_amount: 4.5 * 100,
          remaining_base_amount: 0.5,
        },
      ),
    })
    engine.start()
    await flush()
    expect(orderClient.submitInputs).toHaveLength(0)

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'resting-2',
        client_order_index: 12,
        status: 'canceled-expired',
        price: 100,
        initial_base_amount: 5,
        filled_base_amount: 4.5,
        filled_quote_amount: 4.5 * 100,
      })[0],
    })
    clock.fireNext()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(0)
    expect(status('aborted')).toBeUndefined()
    expect(clock.pendingCount()).toBe(1)

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'resting-1',
        client_order_index: 11,
        status: 'filled',
        price: 100,
        initial_base_amount: 5,
        filled_base_amount: 5,
        filled_quote_amount: 5 * 100,
      })[0],
    })
    clock.fireNext()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]).toMatchObject({
      orderType: ENGINE_ORDER_TYPE.market,
      baseAmount: 50,
    })
  })

  it('aborts with the exchange message when the final market order is rejected as non-retryable', async () => {
    orderClient.submitError = new ApiError('reduce only increases position', 21732)
    const engine = makeEngine(makeConfig({ totalSize: 0.5, reduceOnly: true }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(1)
    expect(orderClient.submitInputs[0]!.orderType).toBe(ENGINE_ORDER_TYPE.market)
    expect(status('aborted')?.reason).toBe('reduce only increases position')
    expect(clock.pendingCount()).toBe(0)
  })

  it('reduce-only: aborts and cancels the other resting orders when one is canceled-reduce-only', async () => {
    orderClient.cancelFills = {
      'resting-2': { filled_base_amount: 1.5, filled_quote_amount: 150 },
    }
    const engine = makeEngine(makeConfig({ reduceOnly: true }), twoRestingOrders())
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'resting-1',
        client_order_index: 11,
        status: 'canceled-reduce-only',
        price: 100,
        initial_base_amount: 5,
        filled_base_amount: 3,
        filled_quote_amount: 300,
      })[0],
    })
    await flush()

    expect(status('completed')).toBeUndefined()
    expect(status('aborted')?.reason).toBe(REDUCE_ONLY_EXHAUSTED_REASON)
    expect(orderClient.cancelInputs.map((c) => c.orderId)).toEqual(['resting-2'])
    expect(removedOrderIds()).toEqual(['resting-1', 'resting-2'])
    expect(lastProgress().filledBaseAmount).toBe(4.5)
    expect(orderClient.submitInputs).toHaveLength(0)
    expect(clock.pendingCount()).toBe(0)
  })

  it('a canceled-reduce-only order does not abort a non-reduce-only iceberg', async () => {
    const engine = makeEngine(makeConfig(), twoRestingOrders())
    engine.start()
    await flush()

    engine.onFillUpdate({
      restingOrder: wsOrder({
        order_id: 'resting-1',
        client_order_index: 11,
        status: 'canceled-reduce-only',
        price: 100,
        initial_base_amount: 5,
        filled_base_amount: 1,
        filled_quote_amount: 100,
      })[0],
    })
    await flush()

    expect(status('aborted')).toBeUndefined()
    expect(orderClient.cancelInputs).toHaveLength(0)
  })

  it('stop() cancels every resting order and credits their final fills', async () => {
    orderClient.cancelFills = {
      'resting-1': { filled_base_amount: 2, filled_quote_amount: 200 },
      'resting-2': { filled_base_amount: 1, filled_quote_amount: 100 },
    }
    const engine = makeEngine(makeConfig(), twoRestingOrders())
    engine.start()
    await flush()

    engine.stop()
    await flush()

    expect(status('aborted')?.reason).toBe('Stopped by user')
    expect(orderClient.cancelInputs.map((c) => c.orderId)).toEqual(['resting-1', 'resting-2'])
    expect(removedOrderIds()).toEqual(['resting-1', 'resting-2'])
    expect(lastProgress().filledBaseAmount).toBe(3)
    expect(clock.pendingCount()).toBe(0)
  })
})

const makePricedConfig = (overrides: Partial<IcebergConfig> = {}): IcebergConfig => ({
  accountIndex: 3,
  marketId: 0,
  isAsk: 0,
  totalSize: 1000,
  reduceOnly: false,
  postOnly: true,
  restingChunkBaseAmount: 10,
  repriceIntervalMs: 1000,
  limitPrice: 105,
  maxRestingOrders: 1,
  ...overrides,
})

const tailResume: IcebergResumeState = {
  filledBaseAmount: 999.5,
  filledQuoteAmount: 999.5 * 100,
  makerBaseAmount: 999.5,
  workingOrders: {},
}

describe('IcebergEngine prices', () => {
  let clock: FakeClock
  let marketData: FakeMarketData
  let orderClient: FakeOrderClient
  let events: EngineEvent[]

  beforeEach(() => {
    clock = new FakeClock()
    marketData = new FakeMarketData()
    marketData.bestAskPrice = 100
    orderClient = new FakeOrderClient()
    events = []
  })

  const makeEngine = (config = makePricedConfig(), resume?: IcebergResumeState) =>
    new IcebergEngine(
      config,
      { marketData, orderClient, clock },
      (event) => events.push(event),
      resume,
    )

  const marketOrders = () => orderClient.submitInputs.filter((input) => input.orderType === 1)

  it('post-only buy chunks and reprices never go above index × (1 + slippage) while the bid runs away', async () => {
    const engine = makeEngine()
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({
      orderType: 0,
      price: 10000,
    })

    marketData.bestBidPrice = 5000
    clock.fireNext()
    await flush()
    marketData.bestBidPrice = 9000
    clock.fireNext()
    await flush()

    const prices = [
      ...orderClient.submitInputs.map((input) => input.price),
      ...orderClient.modifyInputs.map((input) => input.price),
    ]
    expect(orderClient.modifyInputs.length).toBeGreaterThan(0)
    expect(Math.max(...prices)).toBe(10300)
  })

  it('post-only sell chunks and reprices never go below index × (1 − slippage) while the ask runs away', async () => {
    const engine = makeEngine(makePricedConfig({ isAsk: 1, limitPrice: 95 }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({
      orderType: 0,
      price: 10000,
    })

    marketData.bestAskPrice = 1
    clock.fireNext()
    await flush()
    marketData.bestAskPrice = 0.5
    clock.fireNext()
    await flush()

    const prices = [
      ...orderClient.submitInputs.map((input) => input.price),
      ...orderClient.modifyInputs.map((input) => input.price),
    ]
    expect(orderClient.modifyInputs.length).toBeGreaterThan(0)
    expect(Math.min(...prices)).toBe(9700)
  })

  it.each([
    ['buy', 0, 120, 10300],
    ['sell', 1, 80, 9700],
  ] as const)(
    'a marketable non-post-only %s limit past the band rests at the band instead of aborting',
    async (_side, isAsk, limitPrice, bandUnits) => {
      const engine = makeEngine(makePricedConfig({ isAsk, limitPrice, postOnly: false }))
      engine.start()
      await flush()

      expect(orderClient.submitInputs[0]).toMatchObject({
        orderType: 0,
        price: bandUnits,
      })
      expect(engine.getProgress().status).toBe('running')
      expect(events.some((e) => e.type === 'status' && e.status === 'aborted')).toBe(false)
    },
  )

  it('a tighter user limit still wins over the band', async () => {
    const engine = makeEngine(makePricedConfig({ limitPrice: 101, postOnly: false }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ price: 10100 })
  })

  it('places no chunk while the index price is unavailable', async () => {
    marketData.indexPrice = null
    const engine = makeEngine(makePricedConfig({ postOnly: false }))
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(0)
    expect(engine.getProgress().status).toBe('running')

    marketData.indexPrice = 100
    clock.fireNext()
    await flush()

    expect(orderClient.submitInputs[0]).toMatchObject({ price: 10300 })
  })

  it('reprices each chunk against the index at the time of its own modify', async () => {
    const modifyOrder = orderClient.modifyOrder.bind(orderClient)
    orderClient.modifyOrder = (input) => {
      marketData.indexPrice = 95
      return modifyOrder(input)
    }
    const resting = (orderId: string, clientOrderIndex: number) => ({
      order_id: orderId,
      client_order_index: clientOrderIndex,
      status: 'open' as const,
      price: 90,
      initial_base_amount: 10,
      remaining_base_amount: 10,
    })
    const engine = makeEngine(makePricedConfig({ maxRestingOrders: 2 }), {
      filledBaseAmount: 0,
      filledQuoteAmount: 0,
      makerBaseAmount: 0,
      workingOrders: wsWorkingOrders(resting('resting-1', 11), resting('resting-2', 12)),
    })
    engine.start()
    await flush()

    expect(orderClient.modifyInputs.map((input) => input.price)).toEqual([10000, 9785])
  })

  it('stops repricing the remaining chunks once the index drops out mid-pass', async () => {
    const modifyOrder = orderClient.modifyOrder.bind(orderClient)
    orderClient.modifyOrder = (input) => {
      marketData.indexPrice = null
      return modifyOrder(input)
    }
    const resting = (orderId: string, clientOrderIndex: number) => ({
      order_id: orderId,
      client_order_index: clientOrderIndex,
      status: 'open' as const,
      price: 90,
      initial_base_amount: 10,
      remaining_base_amount: 10,
    })
    const engine = makeEngine(makePricedConfig({ maxRestingOrders: 2 }), {
      filledBaseAmount: 0,
      filledQuoteAmount: 0,
      makerBaseAmount: 0,
      workingOrders: wsWorkingOrders(resting('resting-1', 11), resting('resting-2', 12)),
    })
    engine.start()
    await flush()

    expect(orderClient.modifyInputs).toHaveLength(1)
    expect(orderClient.submitInputs).toHaveLength(0)
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
    const engine = makeEngine(makePricedConfig({ maxRestingOrders: 2 }))
    engine.start()
    await flush()

    for (const bid of [5000, 5000, 100, 100]) {
      marketData.bestBidPrice = bid
      clock.fireNext()
      await flush()
    }

    expect(events.some((e) => e.type === 'status' && e.status === 'aborted')).toBe(false)
    expect(engine.getProgress().status).toBe('running')
    const prices = [
      ...orderClient.submitInputs.map((input) => input.price),
      ...orderClient.modifyInputs.map((input) => input.price),
    ]
    expect(Math.max(...prices)).toBe(10300)
  })

  it('adoptOrder: a resting unconfirmed chunk is credited and tracked', () => {
    const engine = makeEngine(makeConfig(), {
      filledBaseAmount: 20,
      filledQuoteAmount: 20 * 100,
      makerBaseAmount: 20,
      workingOrders: {},
    })
    engine.adoptOrder(
      wsOrder({
        order_id: 'adopted-1',
        price: 100,
        initial_base_amount: 10,
        filled_base_amount: 4,
        filled_quote_amount: 4 * 100,
      })[0],
      true,
    )

    expect(engine.getProgress()).toMatchObject({
      status: 'running',
      filledBaseAmount: 24,
      filledQuoteAmount: 24 * 100,
      makerBaseAmount: 24,
    })
    expect(Object.keys(engine.getWorkingOrders())).toEqual(['adopted-1'])
  })

  it('reprices a resumed chunk resting past the band back onto it', async () => {
    const engine = makeEngine(makePricedConfig({ postOnly: false }), {
      filledBaseAmount: 0,
      filledQuoteAmount: 0,
      makerBaseAmount: 0,
      workingOrders: wsWorkingOrders({
        order_id: 'resting-1',
        client_order_index: 11,
        status: 'open',
        price: 120,
        initial_base_amount: 10,
        remaining_base_amount: 10,
      }),
    })
    engine.start()
    await flush()

    expect(orderClient.modifyInputs[0]).toMatchObject({
      orderId: 'resting-1',
      price: 10300,
      isAsk: 0,
    })
  })

  it('the buy tail market order is bounded by the book when it stays inside the index band', async () => {
    marketData.bestAskPrice = 99
    makeEngine(makePricedConfig(), tailResume).start()
    await flush()

    expect(marketOrders()).toHaveLength(1)
    expect(marketOrders()[0]).toMatchObject({ baseAmount: 50, price: 10197 })
  })

  it('caps the buy tail market order at index × (1 + slippage) when the ask runs away', async () => {
    marketData.bestAskPrice = 5000
    makeEngine(makePricedConfig(), tailResume).start()
    await flush()

    expect(marketOrders()[0]).toMatchObject({ baseAmount: 50, price: 10300 })
  })

  it('floors the sell tail market order at index × (1 − slippage) when the bid runs away', async () => {
    marketData.bestBidPrice = 1
    makeEngine(makePricedConfig({ isAsk: 1, limitPrice: 1 }), tailResume).start()
    await flush()

    expect(marketOrders()[0]).toMatchObject({ baseAmount: 50, price: 9700 })
  })

  it('the tail band follows the index', async () => {
    marketData.bestAskPrice = 5000
    marketData.indexPrice = 101
    makeEngine(makePricedConfig(), tailResume).start()
    await flush()

    expect(marketOrders()[0]).toMatchObject({ price: 10403 })
  })

  it('sends no tail market order while the index price is unavailable', async () => {
    marketData.indexPrice = null
    const engine = makeEngine(makePricedConfig(), tailResume)
    engine.start()
    await flush()

    expect(orderClient.submitInputs).toHaveLength(0)
    expect(engine.getProgress().status).toBe('running')
    expect(clock.pendingCount()).toBe(1)

    marketData.indexPrice = 100
    clock.fireNext()
    await flush()

    expect(marketOrders()).toHaveLength(1)
  })
})
