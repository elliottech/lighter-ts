import type { ChaseLimitStrategyRecord } from '../engine/types'
import type { Order } from '../..'
import { useStrategyStore } from '../store/strategyStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { wsOrder } from '../engine/testUtils'

const mocks = vi.hoisted(() => ({
  fetchOrderSnapshot:
    vi.fn<
      (params: { accountIndex: number; clientOrderIndex: number }) => Promise<Order | undefined>
    >(),
}))

vi.mock('../orderSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orderSnapshot')>()),
  fetchOrderSnapshot: mocks.fetchOrderSnapshot,
}))
vi.mock('./captureWorkerException', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./captureWorkerException')>()),
  captureWorkerException: vi.fn(),
}))

const { lookupUnconfirmedOrders } = await import('./reconcileUnconfirmedOrders')
const { SIGNED_TX_LIFETIME_MS } = await import('../orderLifecycle')

const record = (): ChaseLimitStrategyRecord => ({
  id: 'chase-1',
  kind: 'chase-limit',
  config: {
    accountIndex: 5,
    marketId: 1,
    isAsk: 0,
    totalSize: 1,
    reduceOnly: false,
    maxDistancePercent: 0,
    restingChunkBaseAmount: 0.5,
    repriceIntervalMs: 1000,
  },
  progress: {
    status: 'running',
    totalBaseAmount: 1,
    filledBaseAmount: 0.2,
    filledQuoteAmount: 20,
    makerBaseAmount: 0.2,
    nextActionAt: null,
  },
  workingOrders: {},
  unconfirmedOrders: {
    11: { marketId: 1, orderType: 0, sentAt: 1 },
    12: { marketId: 1, orderType: 1, sentAt: 2 },
    13: { marketId: 1, orderType: 0, sentAt: 3 },
  },
  createdAt: 0,
})

const unconfirmedOrders = () => useStrategyStore.getState().strategies['chase-1']!.unconfirmedOrders

const lookup = () => lookupUnconfirmedOrders('chase-1', 5)

describe('lookupUnconfirmedOrders', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(SIGNED_TX_LIFETIME_MS + 1_000)
    mocks.fetchOrderSnapshot.mockReset()
    useStrategyStore.setState({ strategies: { 'chase-1': record() } })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the orders the venue knows, maker for limits, and drops the rest', async () => {
    const [resting] = wsOrder({ order_id: 'o11', client_order_index: 11 })
    const [filled] = wsOrder({
      order_id: 'o12',
      client_order_index: 12,
      status: 'filled',
      type: 'market',
    })
    const snapshots: Record<number, Order> = { 11: resting, 12: filled }
    mocks.fetchOrderSnapshot.mockImplementation(({ clientOrderIndex }) =>
      Promise.resolve(snapshots[clientOrderIndex]),
    )

    await expect(lookup()).resolves.toEqual({
      orders: [
        { order: resting, isMaker: true },
        { order: filled, isMaker: false },
      ],
      error: undefined,
    })

    expect(mocks.fetchOrderSnapshot.mock.calls.map(([p]) => p)).toEqual([
      { accountIndex: 5, clientOrderIndex: 11 },
      { accountIndex: 5, clientOrderIndex: 12 },
      { accountIndex: 5, clientOrderIndex: 13 },
    ])
    expect(unconfirmedOrders()).toEqual({
      11: { marketId: 1, orderType: 0, sentAt: 1 },
      12: { marketId: 1, orderType: 1, sentAt: 2 },
    })
  })

  it('keeps the entry of a lookup that fails past the tx lifetime, and the orders found around it', async () => {
    const [resting] = wsOrder({ order_id: 'o11', client_order_index: 11 })
    const [later] = wsOrder({ order_id: 'o13', client_order_index: 13 })
    const error = new Error('network')
    mocks.fetchOrderSnapshot
      .mockResolvedValueOnce(resting)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(later)

    await expect(lookup()).resolves.toEqual({
      orders: [
        { order: resting, isMaker: true },
        { order: later, isMaker: true },
      ],
      error,
    })

    expect(unconfirmedOrders()).toEqual(record().unconfirmedOrders)
  })

  describe('an order whose signed tx can still execute', () => {
    const sentAt = () => Date.now() - 60_000

    beforeEach(() => {
      useStrategyStore.setState({
        strategies: {
          'chase-1': {
            ...record(),
            unconfirmedOrders: {
              21: { marketId: 1, orderType: 0, sentAt: sentAt() },
            },
          },
        },
      })
    })

    it('is polled for until it lands, then returned', async () => {
      const [landed] = wsOrder({ order_id: 'o21', client_order_index: 21 })
      mocks.fetchOrderSnapshot
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue(landed)

      const result = lookup()
      await vi.advanceTimersByTimeAsync(20_000)

      await expect(result).resolves.toEqual({
        orders: [{ order: landed, isMaker: true }],
        error: undefined,
      })
      expect(mocks.fetchOrderSnapshot).toHaveBeenCalledTimes(3)
    })

    it('is polled for again after a failed lookup', async () => {
      const [landed] = wsOrder({ order_id: 'o21', client_order_index: 21 })
      mocks.fetchOrderSnapshot.mockRejectedValueOnce(new Error('network')).mockResolvedValue(landed)

      const result = lookup()
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(result).resolves.toEqual({
        orders: [{ order: landed, isMaker: true }],
        error: undefined,
      })
      expect(Object.keys(unconfirmedOrders() ?? {})).toEqual(['21'])
    })

    it('is dropped once its lifetime has passed without landing', async () => {
      mocks.fetchOrderSnapshot.mockResolvedValue(undefined)

      const result = lookup()
      await vi.advanceTimersByTimeAsync(SIGNED_TX_LIFETIME_MS)

      await expect(result).resolves.toEqual({ orders: [], error: undefined })
      expect(unconfirmedOrders()).toBeUndefined()
      expect(mocks.fetchOrderSnapshot.mock.calls.length).toBeGreaterThan(50)
    })
  })
})
