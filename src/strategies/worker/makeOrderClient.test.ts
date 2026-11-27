import type { MarketDataSource, MarketMeta, SubmitOrderInput } from '../engine/types'
import { type Order, StrategyOrderKind } from '../..'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  modifyOrder: vi.fn(),
  generateClientOrderIndex: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  addWorkingOrder: vi.fn(),
  addUnconfirmedOrder: vi.fn(),
  removeUnconfirmedOrder: vi.fn(),
  flushLatestStrategyStoreWrite: vi.fn(),
  creditOrderTradeVolumesV2: vi.fn(),
  cancelOrderUntilTerminalState: vi.fn(),
  calls: [] as string[],
}))

vi.mock('../../transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../transactions')>()),
  createOrder: mocks.createOrder,
  modifyOrder: mocks.modifyOrder,
}))
vi.mock('../..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../..')>()),
  transactionConfig: {
    generateClientOrderIndex: mocks.generateClientOrderIndex,
  },
  selectOrderBookMeta: () => ({ price_decimals: 2, size_decimals: 2 }),
  useLighterStore: {
    getState: () => ({}),
    subscribe: mocks.subscribe,
  },
}))
vi.mock('../orderLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderLifecycle')>()),
  cancelOrderUntilTerminalState: mocks.cancelOrderUntilTerminalState,
}))
vi.mock('../orderSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderSnapshot')>()),
  fetchOrderSnapshot: vi.fn(),
}))
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
}))
vi.mock('../store/strategyStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/strategyStore')>()),
  useStrategyStore: {
    getState: () => ({
      addWorkingOrder: mocks.addWorkingOrder,
      addUnconfirmedOrder: mocks.addUnconfirmedOrder,
      removeUnconfirmedOrder: mocks.removeUnconfirmedOrder,
    }),
  },
}))
vi.mock('../store/strategyStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/strategyStorage')>()),
  flushLatestStrategyStoreWrite: mocks.flushLatestStrategyStoreWrite,
}))
vi.mock('./workerIdle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerIdle')>()),
  trackWorkerTask: <T>(task: Promise<T>) => task,
}))
vi.mock('./creditOrderTradeVolumesV2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./creditOrderTradeVolumesV2')>()),
  creditOrderTradeVolumesV2: mocks.creditOrderTradeVolumesV2,
}))

vi.mock('./workerAccountFees', () => ({
  getStrategyIntegratorFees: () => undefined,
}))

const { ApiError } = await import('../..')
const {
  OrderPriceGuardError,
  UnconfirmedOrderError,
  UnpersistedOrderError,
  VolumeQuotaExhaustedError,
  isNonRetryableOrderError,
} = await import('../engine/errors')
const { assertOrderPriceNearIndex } = await import('../engine/planner')
const { drainOrderClients, makeOrderClient } = await import('./makeOrderClient')
const { SIGNED_TX_LIFETIME_MS } = await import('../orderLifecycle')
const { fetchOrderSnapshot } = await import('../orderSnapshot')
class FakeMarketData implements MarketDataSource {
  market: MarketMeta | undefined = {
    market_id: 0,
    size_decimals: 2,
    price_decimals: 2,
    min_base_amount: '0',
    min_quote_amount: '0',
    multiplier: '1',
    display_price_decimals: 2,
  }
  indexPrice: number | null = 100
  markPrice: number | null = null

  getMarket() {
    return this.market
  }
  getIndexPrice() {
    return this.indexPrice
  }
  getMarkPrice() {
    return this.markPrice
  }
  getMidPrice() {
    return 100
  }
  getBestBidPrice() {
    return 100
  }
  getBestAskPrice() {
    return 100
  }
}

const submitInput = (overrides: Partial<SubmitOrderInput> = {}): SubmitOrderInput => ({
  accountIndex: 1,
  orderBookIndex: 0,
  baseAmount: 100,
  price: 10_000,
  isAsk: 0,
  orderType: 0,
  timeInForce: 1,
  reduceOnly: 0,
  triggerPrice: 0,
  orderExpiry: 0,
  strategyOrderKind: StrategyOrderKind.AdvancedTwap,
  ...overrides,
})

const modifyInput = {
  accountIndex: 1,
  marketId: 0,
  orderId: '42',
  clientOrderIndex: 7,
  price: 9950,
  triggerPrice: 0,
  baseAmount: 100,
  isAsk: 0 as const,
}

describe('makeOrderClient modifyOrder', () => {
  beforeEach(() => {
    mocks.modifyOrder.mockReset()
    mocks.subscribe.mockClear()
    mocks.addWorkingOrder.mockReset()
  })

  it('rejects with the exchange error when the modify cannot be margined', async () => {
    const error = new ApiError('not enough margin to create the order', 21739)
    mocks.modifyOrder.mockRejectedValue(error)
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    await expect(client.modifyOrder(modifyInput)).rejects.toBe(error)
    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.addWorkingOrder).not.toHaveBeenCalled()
  })

  it('keeps waiting for the ws confirmation on other modify errors', async () => {
    mocks.modifyOrder.mockRejectedValue(new Error('network error'))
    const appliedOrder = {
      order_id: '42',
      client_order_index: 7,
      status: 'filled',
      price: '99.50',
      trigger_price: '0.00',
      initial_base_amount: '1.00',
    } as unknown as Order
    mocks.subscribe.mockImplementationOnce(((
      _selector: unknown,
      listener: (order: Order) => void,
    ) => {
      listener(appliedOrder)
      return () => {}
    }) as never)
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    await expect(client.modifyOrder(modifyInput)).resolves.toEqual({
      order: appliedOrder,
    })
  })
})

describe('order price guard', () => {
  let marketData: FakeMarketData

  beforeEach(() => {
    marketData = new FakeMarketData()
    mocks.createOrder.mockReset()
    mocks.modifyOrder.mockReset()
    mocks.flushLatestStrategyStoreWrite.mockReset().mockResolvedValue(true)
  })

  const client = () => makeOrderClient('strategy-1', () => new Map(), marketData)

  it.each([
    ['buy', 0, 11_001],
    ['sell', 1, 8_999],
  ] as const)(
    'refuses a %s submit priced past the guard before it is signed',
    async (_side, isAsk, price) => {
      const submit = client().submitOrder(submitInput({ isAsk, price }))

      await expect(submit).rejects.toBeInstanceOf(OrderPriceGuardError)
      expect(mocks.createOrder).not.toHaveBeenCalled()
    },
  )

  it('checks the price against the index as it is once the order is saved', async () => {
    mocks.removeUnconfirmedOrder.mockClear()
    mocks.generateClientOrderIndex.mockResolvedValue(77)
    mocks.flushLatestStrategyStoreWrite.mockImplementation(() => {
      marketData.indexPrice = 50
      return Promise.resolve(true)
    })

    await expect(client().submitOrder(submitInput({ price: 10_500 }))).rejects.toBeInstanceOf(
      OrderPriceGuardError,
    )

    expect(mocks.createOrder).not.toHaveBeenCalled()
    expect(mocks.removeUnconfirmedOrder).toHaveBeenCalledWith('strategy-1', 77)
  })

  it.each([
    ['limit', 0],
    ['market', 1],
  ] as const)('guards %s orders alike', async (_type, orderType) => {
    await expect(
      client().submitOrder(submitInput({ orderType, price: 2_000_749 })),
    ).rejects.toBeInstanceOf(OrderPriceGuardError)
    expect(mocks.createOrder).not.toHaveBeenCalled()
  })

  it.each([
    ['buy', 0, 9950],
    ['sell', 1, 10_050],
  ] as const)('refuses a %s modify priced past the guard', async (_side, isAsk, _ok) => {
    const modify = client().modifyOrder({
      ...modifyInput,
      isAsk,
      price: isAsk === 1 ? 8_999 : 11_001,
    })

    await expect(modify).rejects.toBeInstanceOf(OrderPriceGuardError)
    expect(mocks.modifyOrder).not.toHaveBeenCalled()
  })

  it('lets prices up to the guard through, and favourable prices of any distance', () => {
    for (const [price, isAsk] of [
      [11_000, 0],
      [9_000, 1],
      [1, 0],
      [1_000_000, 1],
    ] as const) {
      expect(() => assertOrderPriceNearIndex(marketData, 0, price, isAsk)).not.toThrow()
    }
  })

  it('passes an order inside the guard on towards the venue', async () => {
    const error = new ApiError('not enough margin to create the order', 21739)
    mocks.createOrder.mockRejectedValue(error)

    await expect(client().submitOrder(submitInput({ price: 10_500 }))).rejects.toBe(error)
  })

  it('never forwards the side to the store modify call', async () => {
    const error = new ApiError('not enough margin to create the order', 21739)
    mocks.modifyOrder.mockRejectedValue(error)

    await expect(client().modifyOrder(modifyInput)).rejects.toBe(error)
    expect(mocks.modifyOrder.mock.calls[0]![0]).not.toHaveProperty('isAsk')
  })

  it('falls back to the mark price when there is no index', () => {
    marketData.indexPrice = null
    marketData.markPrice = 200

    expect(() => assertOrderPriceNearIndex(marketData, 0, 21_000, 0)).not.toThrow()
    expect(() => assertOrderPriceNearIndex(marketData, 0, 22_001, 0)).toThrow(
      'more than 10% above the mark price 200',
    )
  })

  it('refuses every order when there is neither an index nor a mark price', () => {
    marketData.indexPrice = null

    expect(() => assertOrderPriceNearIndex(marketData, 0, 10_000, 0)).toThrow(
      'No index price to check the order price against',
    )
  })

  it('refuses every order for an unknown market', () => {
    marketData.market = undefined

    expect(() => assertOrderPriceNearIndex(marketData, 0, 10_000, 0)).toThrow(
      'No index price to check the order price against',
    )
  })

  it('names the side and the reference in the abort reason', () => {
    expect(() => assertOrderPriceNearIndex(marketData, 0, 2_000_749, 0)).toThrow(
      'Order price 20007.49 is more than 10% above the index price 100',
    )
  })

  it('is a non-retryable order error, so the strategy aborts', () => {
    expect(isNonRetryableOrderError(new OrderPriceGuardError('x'))).toBe(true)
  })

  it('on its own stops the strategy at its first market order past 10% of the index', () => {
    marketData.indexPrice = 2_400
    const runawayMarketOrderLimits = [
      247_889, 247_889, 248_005, 248_153, 248_439, 248_639, 249_193, 256_161, 256_327, 275_779,
      309_000, 309_077, 309_193, 311_692, 312_047, 318_285, 515_000, 648_900, 2_060_000, 7_313_000,
    ]
    const refused = runawayMarketOrderLimits.map((price) => {
      try {
        assertOrderPriceNearIndex(marketData, 0, price, 0)
        return false
      } catch (error) {
        return error instanceof OrderPriceGuardError
      }
    })

    expect(refused.indexOf(true)).toBe(9)
    expect(refused.slice(9).every(Boolean)).toBe(true)
  })
})

const confirmWith = (order: Order) =>
  mocks.subscribe.mockImplementationOnce(((
    _selector: unknown,
    listener: (order: Order) => void,
  ) => {
    listener(order)
    return () => {}
  }) as never)

describe('makeOrderClient submitOrder', () => {
  beforeEach(() => {
    mocks.calls.length = 0
    for (const [name, mock] of Object.entries(mocks)) {
      if (!Array.isArray(mock)) {
        mock.mockReset()
        mock.mockImplementation((() => {
          mocks.calls.push(name)
        }) as never)
      }
    }
    mocks.subscribe.mockImplementation(() => () => {})
    mocks.generateClientOrderIndex.mockResolvedValue(77)
    mocks.flushLatestStrategyStoreWrite.mockImplementation(() => {
      mocks.calls.push('flushLatestStrategyStoreWrite')
      return Promise.resolve(true)
    })
    mocks.createOrder.mockImplementation(() => {
      mocks.calls.push('createOrder')
      return Promise.resolve()
    })
  })

  it('persists the client order index before the order is sent', async () => {
    const order = {
      order_id: '9',
      client_order_index: 77,
      status: 'open',
    } as Order
    confirmWith(order)
    const client = makeOrderClient(
      'strategy-1',
      () => new Map([['strategy-1', { getProgress: () => ({ status: 'running' }) }]]) as never,
      new FakeMarketData(),
    )

    await expect(client.submitOrder(submitInput())).resolves.toEqual({ order })

    expect(mocks.generateClientOrderIndex).toHaveBeenCalledWith(StrategyOrderKind.AdvancedTwap)
    expect(mocks.addUnconfirmedOrder).toHaveBeenCalledWith(
      'strategy-1',
      77,
      expect.objectContaining({
        marketId: 0,
        orderType: 0,
      }),
    )
    expect(mocks.calls).toEqual([
      'addUnconfirmedOrder',
      'flushLatestStrategyStoreWrite',
      'createOrder',
      'addWorkingOrder',
    ])
    expect(mocks.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderIndex: 77 }),
    )
    expect(mocks.removeUnconfirmedOrder).not.toHaveBeenCalled()
  })

  it('credits an order that closed on arrival instead of tracking it', async () => {
    const order = {
      order_id: '9',
      client_order_index: 77,
      status: 'filled',
    } as Order
    confirmWith(order)
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    await expect(client.submitOrder(submitInput())).resolves.toEqual({ order })

    // Crediting the volumes drops the unconfirmed entry in the same pass.
    expect(mocks.creditOrderTradeVolumesV2).toHaveBeenCalledWith('strategy-1', order)
    expect(mocks.addWorkingOrder).not.toHaveBeenCalled()
  })

  it('keeps the unconfirmed entry when the order executed but was never seen', async () => {
    vi.useFakeTimers()
    try {
      mocks.createOrder.mockResolvedValue({})
      vi.mocked(fetchOrderSnapshot).mockResolvedValue(undefined)
      const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

      const rejection = expect(client.submitOrder(submitInput())).rejects.toBeInstanceOf(
        UnconfirmedOrderError,
      )
      await vi.advanceTimersByTimeAsync(SIGNED_TX_LIFETIME_MS)
      await rejection

      expect(mocks.addUnconfirmedOrder).toHaveBeenCalledTimes(1)
      expect(mocks.removeUnconfirmedOrder).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing when the unconfirmed entry could not be saved', async () => {
    mocks.flushLatestStrategyStoreWrite.mockResolvedValue(false)
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    await expect(client.submitOrder(submitInput())).rejects.toBeInstanceOf(UnpersistedOrderError)

    expect(mocks.createOrder).not.toHaveBeenCalled()
    expect(mocks.removeUnconfirmedOrder).toHaveBeenCalledWith('strategy-1', 77)
  })

  it('drops the unconfirmed entry when the submit throws', async () => {
    const error = new ApiError('invalid nonce', 21104)
    mocks.createOrder.mockRejectedValue(error)
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    await expect(client.submitOrder(submitInput())).rejects.toBe(error)

    expect(mocks.addUnconfirmedOrder).toHaveBeenCalledTimes(1)
    expect(mocks.removeUnconfirmedOrder).toHaveBeenCalledWith('strategy-1', 77)
  })
})

describe('makeOrderClient volume quota rejections', () => {
  const volumeQuotaError = () => new ApiError('Too Many Requests!:  Not enough volume quota', 23000)

  beforeEach(() => {
    mocks.createOrder.mockReset()
    mocks.cancelOrderUntilTerminalState.mockReset()
    mocks.generateClientOrderIndex.mockResolvedValue(77)
    mocks.flushLatestStrategyStoreWrite.mockResolvedValue(true)
  })

  it('fails the 5th order rejected in a row with an error that aborts the strategy', async () => {
    mocks.createOrder.mockRejectedValue(volumeQuotaError())
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    for (let i = 0; i < 4; i++) {
      await expect(client.submitOrder(submitInput())).rejects.toMatchObject({ code: 23000 })
    }
    const fifth = await client.submitOrder(submitInput()).catch((error: unknown) => error)

    expect(fifth).toBeInstanceOf(VolumeQuotaExhaustedError)
    expect(isNonRetryableOrderError(fifth)).toBe(true)
    expect((fifth as Error).message).toBe(
      'Stopped after 5 orders in a row were rejected for not enough volume quota',
    )
  })

  it('starts counting again after an accepted order or another error', async () => {
    const filledOrder = { order_id: '42', client_order_index: 77, status: 'filled' } as Order
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())
    const rejectFourTimes = async () => {
      mocks.createOrder.mockRejectedValue(volumeQuotaError())
      for (let i = 0; i < 4; i++) {
        await expect(client.submitOrder(submitInput())).rejects.toMatchObject({ code: 23000 })
      }
    }

    await rejectFourTimes()
    mocks.createOrder.mockRejectedValueOnce(new ApiError('invalid nonce', 21104))
    await expect(client.submitOrder(submitInput())).rejects.toMatchObject({ code: 21104 })
    await rejectFourTimes()
    mocks.createOrder.mockResolvedValueOnce(undefined)
    confirmWith(filledOrder)
    await expect(client.submitOrder(submitInput())).resolves.toEqual({ order: filledOrder })
    await rejectFourTimes()
  })

  it('does not count cancels, so a failed cancel leaves the count alone', async () => {
    mocks.createOrder.mockRejectedValue(volumeQuotaError())
    mocks.cancelOrderUntilTerminalState.mockRejectedValue(new Error('cancel timed out'))
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    for (let i = 0; i < 4; i++) {
      await expect(client.submitOrder(submitInput())).rejects.toMatchObject({ code: 23000 })
    }
    await expect(client.cancelOrder(modifyInput)).rejects.toThrow('cancel timed out')

    await expect(client.submitOrder(submitInput())).rejects.toBeInstanceOf(
      VolumeQuotaExhaustedError,
    )
  })

  it('keeps a separate count for each strategy', async () => {
    mocks.createOrder.mockRejectedValue(volumeQuotaError())
    const first = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())
    const second = makeOrderClient('strategy-2', () => new Map(), new FakeMarketData())

    for (let i = 0; i < 4; i++) {
      await expect(first.submitOrder(submitInput())).rejects.toMatchObject({ code: 23000 })
      await expect(second.submitOrder(submitInput())).rejects.toMatchObject({ code: 23000 })
    }

    await expect(first.submitOrder(submitInput())).rejects.toBeInstanceOf(VolumeQuotaExhaustedError)
  })

  it('does not count a 23000 rejection that is not about volume quota', async () => {
    mocks.createOrder.mockRejectedValue(new ApiError('Too Many Requests!', 23000))
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    for (let i = 0; i < 6; i++) {
      await expect(client.submitOrder(submitInput())).rejects.toBeInstanceOf(ApiError)
    }
  })
})

// Last: draining is process-wide and cannot be undone.
describe('makeOrderClient while draining', () => {
  it('sends no new submit or modify but still cancels', async () => {
    mocks.createOrder.mockReset()
    mocks.modifyOrder.mockReset()
    mocks.generateClientOrderIndex.mockReset()
    mocks.addUnconfirmedOrder.mockReset()
    const canceled = { order_id: '42', status: 'canceled' } as unknown as Order
    mocks.cancelOrderUntilTerminalState.mockReset().mockResolvedValue(canceled)
    const client = makeOrderClient('strategy-1', () => new Map(), new FakeMarketData())

    drainOrderClients()
    const settled = vi.fn()
    void client.submitOrder(submitInput()).then(settled, settled)
    void client.modifyOrder(modifyInput).then(settled, settled)
    const cancel = client.cancelOrder({
      accountIndex: 1,
      marketId: 0,
      orderId: '42',
      clientOrderIndex: 7,
    })

    await expect(cancel).resolves.toEqual({ order: canceled })
    await new Promise((resolve) => setTimeout(resolve))
    expect(settled).not.toHaveBeenCalled()
    expect(mocks.generateClientOrderIndex).not.toHaveBeenCalled()
    expect(mocks.addUnconfirmedOrder).not.toHaveBeenCalled()
    expect(mocks.createOrder).not.toHaveBeenCalled()
    expect(mocks.modifyOrder).not.toHaveBeenCalled()
  })
})
