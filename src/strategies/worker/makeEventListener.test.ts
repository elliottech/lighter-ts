import type { ChaseLimitStrategyRecord } from '../engine/types'
import { useStrategyStore } from '../store/strategyStore'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { wsOrder } from '../engine/testUtils'
import { makeEventListener } from './makeEventListener'

const creditOrderTradeVolumesV2 = vi.hoisted(() => vi.fn())

vi.mock('./creditOrderTradeVolumesV2', () => ({ creditOrderTradeVolumesV2 }))
vi.mock('./captureWorkerException', () => ({ captureWorkerException: vi.fn() }))

const record = (): ChaseLimitStrategyRecord => ({
  id: 'chase-1',
  kind: 'chase-limit',
  config: {
    accountIndex: 0,
    marketId: 1,
    isAsk: 0,
    totalSize: 1,
    reduceOnly: false,
    maxDistancePercent: 0,
    restingChunkBaseAmount: 1,
    repriceIntervalMs: 1000,
  },
  progress: {
    status: 'running',
    totalBaseAmount: 1,
    filledBaseAmount: 0,
    filledQuoteAmount: 0,
    makerBaseAmount: 0,
    nextActionAt: null,
  },
  workingOrders: {},
  createdAt: 0,
})

describe('makeEventListener status', () => {
  const postMessage = vi.fn()

  beforeEach(() => {
    postMessage.mockReset()
    useStrategyStore.setState({ strategies: {} })
    useStrategyStore.getState().upsert(record())
  })

  it('persists a terminal status, drops the engine and posts the written record', () => {
    const engines = new Map([['chase-1', {} as never]])
    const listener = makeEventListener('chase-1', () => engines, postMessage)
    listener({ type: 'status', status: 'completed' })
    const written = useStrategyStore.getState().strategies['chase-1']
    expect(written?.progress.status).toBe('completed')
    expect(engines.has('chase-1')).toBe(false)
    expect(postMessage).toHaveBeenCalledWith({
      kind: 'event',
      id: 'chase-1',
      event: { type: 'status', status: 'completed', record: written },
    })
  })
})

describe('makeEventListener updateWorkingOrder', () => {
  const listener = makeEventListener('chase-1', () => new Map(), vi.fn())

  beforeEach(() => {
    useStrategyStore.setState({ strategies: {} })
    useStrategyStore.getState().upsert(record())
  })

  it('refreshes the persisted snapshot of a tracked order', () => {
    const [resting] = wsOrder({ order_id: '7', filled_base_amount: 0 })
    useStrategyStore.getState().addWorkingOrder('chase-1', resting)
    const [partial] = wsOrder({ order_id: '7', filled_base_amount: 0.4 })
    listener({ type: 'updateWorkingOrder', order: partial })
    expect(useStrategyStore.getState().strategies['chase-1']?.workingOrders['7']).toBe(partial)
  })

  it('ignores an order the strategy does not track', () => {
    const [order] = wsOrder({ order_id: '7', filled_base_amount: 0.4 })
    listener({ type: 'updateWorkingOrder', order })
    expect(useStrategyStore.getState().strategies['chase-1']?.workingOrders).toEqual({})
  })
})

describe('makeEventListener removeWorkingOrder', () => {
  const listener = makeEventListener('chase-1', () => new Map(), vi.fn())

  beforeEach(() => {
    creditOrderTradeVolumesV2.mockReset()
    useStrategyStore.setState({ strategies: {} })
    useStrategyStore.getState().upsert(record())
  })

  it('credits a tracked order that left the book', () => {
    const [order] = wsOrder({ order_id: '7', filled_base_amount: 1 })
    useStrategyStore.getState().addWorkingOrder('chase-1', order)
    listener({ type: 'removeWorkingOrder', order })
    expect(creditOrderTradeVolumesV2).toHaveBeenCalledWith('chase-1', order)
  })

  it('credits an adopted unconfirmed order that left the book', () => {
    const [order] = wsOrder({
      order_id: '7',
      client_order_index: 70,
      filled_base_amount: 1,
    })
    useStrategyStore.getState().addUnconfirmedOrder('chase-1', 70, {
      marketId: 1,
      orderType: 0,
      sentAt: 0,
    })
    listener({ type: 'removeWorkingOrder', order })
    expect(creditOrderTradeVolumesV2).toHaveBeenCalledWith('chase-1', order)
  })

  it('does not credit an order the order client already credited', () => {
    const [order] = wsOrder({ order_id: '7', filled_base_amount: 1 })
    listener({ type: 'removeWorkingOrder', order })
    expect(creditOrderTradeVolumesV2).not.toHaveBeenCalled()
  })
})
