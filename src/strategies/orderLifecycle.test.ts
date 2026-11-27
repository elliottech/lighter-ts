import type { Order } from '..'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createOrder: vi.fn(),
  fetchOrderSnapshot: vi.fn(),
  modifyOrder: vi.fn(),
  cancelOrder: vi.fn(),
  listener: undefined as ((order: Order | undefined) => void) | undefined,
}))

vi.mock('../transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../transactions')>()),
  createOrder: mocks.createOrder,
  modifyOrder: mocks.modifyOrder,
  cancelOrder: mocks.cancelOrder,
}))
vi.mock('./orderSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orderSnapshot')>()),
  fetchOrderSnapshot: mocks.fetchOrderSnapshot,
}))
vi.mock('..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('..')>()),
  selectOrderBookMeta: () => ({ price_decimals: 2, size_decimals: 2 }),
  useLighterStore: {
    getState: () => ({}),
    subscribe: (_selector: unknown, listener: (order: Order | undefined) => void) => {
      mocks.listener = listener
      return () => {}
    },
  },
}))

const { ApiError, INVALID_ORDER_INDEX_CODE } = await import('..')
const { cancelOrderUntilTerminalState, createOrderUntil, modifyOrderUntilApplied } = await import(
  './orderLifecycle'
)

const filledOrder = {
  client_order_index: 7,
  status: 'filled',
  price: '1.00',
  trigger_price: '0.00',
  initial_base_amount: '1.00',
} as unknown as Order

const invalidOrderIndex = () => new ApiError('invalid order index', INVALID_ORDER_INDEX_CODE)

describe('order lifecycle when the order left the book first', () => {
  beforeEach(() => {
    mocks.listener = undefined
    mocks.modifyOrder.mockReset()
    mocks.cancelOrder.mockReset()
  })

  it('resolves a modify with the ws-confirmed filled order', async () => {
    mocks.modifyOrder.mockRejectedValue(invalidOrderIndex())

    const result = modifyOrderUntilApplied({
      accountIndex: 1,
      marketId: 0,
      orderId: '42',
      clientOrderIndex: 7,
      price: 200,
      triggerPrice: 0,
      baseAmount: 100,
    })
    await vi.waitFor(() => expect(mocks.listener).toBeDefined())
    mocks.listener?.(filledOrder)

    await expect(result).resolves.toBe(filledOrder)
  })

  it('resolves a cancel with the ws-confirmed filled order', async () => {
    mocks.cancelOrder.mockRejectedValue(invalidOrderIndex())

    const result = cancelOrderUntilTerminalState({
      accountIndex: 1,
      marketId: 0,
      orderId: '42',
      clientOrderIndex: 7,
    })
    await vi.waitFor(() => expect(mocks.listener).toBeDefined())
    mocks.listener?.(filledOrder)

    await expect(result).resolves.toBe(filledOrder)
  })
})

describe('modify rejected by the exchange', () => {
  const request = {
    accountIndex: 1,
    marketId: 0,
    orderId: '42',
    clientOrderIndex: 7,
    price: 200,
    triggerPrice: 0,
    baseAmount: 100,
  }

  beforeEach(() => {
    mocks.listener = undefined
    mocks.modifyOrder.mockReset()
  })

  it('rejects with the venue error when the account cannot margin the modify', async () => {
    const error = new ApiError('not enough margin to create the order', 21739)
    mocks.modifyOrder.mockRejectedValue(error)

    await expect(modifyOrderUntilApplied(request)).rejects.toBe(error)
    expect(mocks.listener).toBeUndefined()
  })

  it('rejects with the venue error when the reduce-only modify has no position left', async () => {
    const error = new ApiError('reduce only increases position', 21732)
    mocks.modifyOrder.mockRejectedValue(error)

    await expect(modifyOrderUntilApplied(request)).rejects.toBe(error)
    expect(mocks.listener).toBeUndefined()
  })
})

describe('modify rate-limited by the exchange', () => {
  const request = {
    accountIndex: 1,
    marketId: 0,
    orderId: '42',
    clientOrderIndex: 7,
    price: 200,
    triggerPrice: 0,
    baseAmount: 100,
  }
  const unchangedOrder = {
    client_order_index: 7,
    status: 'open',
    price: '1.00',
    trigger_price: '0.00',
    initial_base_amount: '1.00',
  } as unknown as Order

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.listener = undefined
    mocks.modifyOrder.mockReset()
    mocks.fetchOrderSnapshot.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects with the rate limit error once the order is still unchanged', async () => {
    const error = new ApiError('Too Many Requests!:  Not enough volume quota', 23000)
    mocks.modifyOrder.mockRejectedValue(error)
    mocks.fetchOrderSnapshot.mockResolvedValue(unchangedOrder)

    const result = modifyOrderUntilApplied(request)
    const assertion = expect(result).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(10_000)

    await assertion
    expect(mocks.fetchOrderSnapshot).toHaveBeenCalledTimes(1)
  })
})

describe('create whose order shows up late', () => {
  const request = {
    accountIndex: 1,
    orderBookIndex: 0,
    clientOrderIndex: 7,
    baseAmount: 100,
    price: 100,
    isAsk: 0,
    orderType: 0,
    timeInForce: 1,
    reduceOnly: 0,
    triggerPrice: 0,
    orderExpiry: 0,
  }
  const openOrder = { client_order_index: 7, status: 'open' } as Order

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.createOrder.mockReset()
    mocks.fetchOrderSnapshot.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps looking the order up over REST after the first miss', async () => {
    mocks.createOrder.mockRejectedValue(new Error('Tx Timeout'))
    mocks.fetchOrderSnapshot
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue(openOrder)

    const result = createOrderUntil(request, () => true)
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(result).resolves.toBe(openOrder)
    expect(mocks.fetchOrderSnapshot).toHaveBeenCalledTimes(3)
  })

  it('rejects at once when the exchange refused the order', async () => {
    const error = new ApiError('not enough margin to create the order', 21739)
    mocks.createOrder.mockRejectedValue(error)

    await expect(createOrderUntil(request, () => true)).rejects.toBe(error)
    expect(mocks.fetchOrderSnapshot).not.toHaveBeenCalled()
  })
})

describe('cancel rate-limited by the exchange', () => {
  const request = { accountIndex: 1, marketId: 0, orderId: '42', clientOrderIndex: 7 }
  const openOrder = { client_order_index: 7, status: 'open' } as Order
  const canceledOrder = { client_order_index: 7, status: 'canceled' } as Order
  const rateLimited = () => new ApiError('Too Many Requests', 23000)

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.listener = undefined
    mocks.cancelOrder.mockReset()
    mocks.fetchOrderSnapshot.mockReset()
    mocks.fetchOrderSnapshot.mockResolvedValue(openOrder)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the cancel again until the order leaves the book', async () => {
    mocks.cancelOrder.mockRejectedValueOnce(rateLimited()).mockResolvedValue({})

    const result = cancelOrderUntilTerminalState(request)
    result.catch(() => {})
    await vi.advanceTimersByTimeAsync(5_000)

    expect(mocks.cancelOrder).toHaveBeenCalledTimes(2)
    mocks.listener?.(canceledOrder)
    await expect(result).resolves.toBe(canceledOrder)
  })

  it('keeps resending through a rate limit that lasts minutes', async () => {
    mocks.cancelOrder.mockRejectedValue(rateLimited())

    const result = cancelOrderUntilTerminalState(request)
    result.catch(() => {})
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    mocks.cancelOrder.mockResolvedValue({})
    await vi.advanceTimersByTimeAsync(60_000)
    mocks.listener?.(canceledOrder)

    await expect(result).resolves.toBe(canceledOrder)
  })

  it('stops resending once the order is terminal', async () => {
    mocks.cancelOrder.mockRejectedValueOnce(rateLimited()).mockResolvedValue({})

    const result = cancelOrderUntilTerminalState(request)
    await vi.waitFor(() => expect(mocks.listener).toBeDefined())
    mocks.listener?.(canceledOrder)
    await expect(result).resolves.toBe(canceledOrder)
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    expect(mocks.cancelOrder).toHaveBeenCalledTimes(1)
  })

  it('gives up with the order still live once the retry window ends', async () => {
    mocks.cancelOrder.mockRejectedValue(rateLimited())

    const result = cancelOrderUntilTerminalState(request)
    result.catch(() => {})
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    await expect(result).rejects.toThrow()
    const sent = mocks.cancelOrder.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(mocks.cancelOrder).toHaveBeenCalledTimes(sent)
  })
})
