import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FetchError } from 'zklighter-perps'

import {
  TX_LOOKUP_ATTEMPTS,
  TX_LOOKUP_RETRY_DELAY,
  TX_LOOKUP_TIMEOUT,
  TX_TIMEOUT,
} from '../constants/order'
import type { Tx } from '../store/types'
import type { OrderParams } from '../types/order'
import { StrategyOrderKind } from '../types/StrategyOrderKind'
import { isTxTimeoutError } from './sendTx'

import { createGroupedOrders, createOrder, createOrderBatch } from './orders'

const mocks = vi.hoisted(() => ({
  generateClientOrderIndex: vi.fn((kind = 0) => Promise.resolve(100 + kind)),
  signCreateOrder: vi.fn(({ orderBookIndex }: { orderBookIndex: number }) =>
    Promise.resolve({ txHash: `hash-${orderBookIndex}`, txInfo: '{}' }),
  ),
  signCreateGroupedOrders: vi.fn(() => Promise.resolve({ txHash: 'hash', txInfo: '{}' })),
  sendTxBatch: vi.fn(),
  tx: vi.fn(),
  txCallbacks: [] as ((tx: Tx) => void)[],
}))

vi.mock('../lib/apis', () => ({
  apis: { transactionApi: { sendTxBatch: mocks.sendTxBatch, tx: mocks.tx } },
}))
vi.mock('./getNonce', () => ({ getNonce: () => Promise.resolve(1) }))
vi.mock('./sendTx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sendTx')>()),
  sendWithNonceRetry: (_type: number, _account: number, sign: (nonce: number) => unknown) =>
    sign(1),
}))
vi.mock('../ws-sub-store/utils', () => ({
  subscribeToAccountTx: (callback: (tx: Tx) => void) => mocks.txCallbacks.push(callback),
  unsubscribeToAccountTx: vi.fn(),
}))
vi.mock('../lib/transactionConfig', () => ({
  transactionConfig: {
    skipNonce: false,
    generateClientOrderIndex: mocks.generateClientOrderIndex,
    signers: {
      signCreateOrder: mocks.signCreateOrder,
      signCreateGroupedOrders: mocks.signCreateGroupedOrders,
    },
  },
}))

// Every lookup attempt hangs until its timeout, with the retry delays between them.
const LOOKUP_WINDOW =
  TX_LOOKUP_ATTEMPTS * TX_LOOKUP_TIMEOUT + (TX_LOOKUP_ATTEMPTS - 1) * TX_LOOKUP_RETRY_DELAY

const create = (orderBookIndex: number) =>
  ({ type: 'create', params: { accountIndex: 1, orderBookIndex } }) as OrderParams

describe('createOrderBatch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.txCallbacks.length = 0
  })

  it('returns a recognisable timeout for a leg that cannot be looked up', async () => {
    mocks.sendTxBatch.mockResolvedValueOnce({})
    const failed = {
      hash: 'hash-1',
      status: 3,
      event_info: JSON.stringify({ ae: JSON.stringify({ code: 21700, message: 'x' }) }),
    }
    mocks.tx.mockImplementation(({ value }: { value: string }) =>
      value === 'hash-1' ? Promise.resolve(failed) : Promise.reject(new Error('network down')),
    )

    const pending = createOrderBatch(1, [create(0), create(1)])
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT + LOOKUP_WINDOW)
    const [timedOut, rejected] = await pending

    expect(isTxTimeoutError(timedOut)).toBe(true)
    expect((timedOut as Error).message).toBe('Tx Timeout')
    expect(rejected).toBeInstanceOf(Error)
    expect(isTxTimeoutError(rejected)).toBe(false)
  })

  it("looks hung legs up in parallel, so the batch waits for one leg's lookups", async () => {
    mocks.sendTxBatch.mockResolvedValueOnce({})
    mocks.tx.mockImplementation(() => new Promise(() => {}))

    let results: (Tx | Error)[] | undefined
    void createOrderBatch(1, [create(0), create(1), create(2)]).then((r) => (results = r))
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT + LOOKUP_WINDOW)

    expect(results).toHaveLength(3)
    expect(results!.every(isTxTimeoutError)).toBe(true)
  })

  it('looks every leg up instead of failing when the send fails on the network', async () => {
    mocks.sendTxBatch.mockRejectedValueOnce(new FetchError(new TypeError('Network request failed')))
    const executed = (hash: string) => ({ hash, status: 2, event_info: '{}' })
    mocks.tx.mockImplementation(({ value }: { value: string }) => Promise.resolve(executed(value)))

    const pending = createOrderBatch(1, [create(0), create(1)])
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT)

    expect(await pending).toEqual([executed('hash-0'), executed('hash-1')])
  })
})

describe('client order index strategy kind', () => {
  afterEach(() => vi.clearAllMocks())

  it('tags a created order with the given kind and keeps it out of the signed params', async () => {
    await createOrder({
      accountIndex: 1,
      orderBookIndex: 0,
      strategyOrderKind: StrategyOrderKind.Rfq,
    } as Parameters<typeof createOrder>[0])

    expect(mocks.generateClientOrderIndex).toHaveBeenCalledWith(StrategyOrderKind.Rfq)
    const params = mocks.signCreateOrder.mock.calls[0]?.[0]
    expect(params).toMatchObject({ clientOrderIndex: 104 })
    expect(params).not.toHaveProperty('strategyOrderKind')
  })

  it('leaves an order untagged without a kind and keeps a caller-provided index', async () => {
    await createOrder({ accountIndex: 1, orderBookIndex: 0 } as Parameters<typeof createOrder>[0])
    expect(mocks.generateClientOrderIndex).toHaveBeenCalledWith(StrategyOrderKind.None)

    mocks.generateClientOrderIndex.mockClear()
    await createOrder({
      accountIndex: 1,
      orderBookIndex: 0,
      clientOrderIndex: 7,
      strategyOrderKind: StrategyOrderKind.Rfq,
    } as Parameters<typeof createOrder>[0])
    expect(mocks.generateClientOrderIndex).not.toHaveBeenCalled()
  })

  it('tags only the parent leg of a grouped order', async () => {
    await createGroupedOrders({
      accountIndex: 1,
      groupingType: 1,
      orders: [{ orderBookIndex: 0 }, { orderBookIndex: 0 }, { orderBookIndex: 0 }] as Parameters<
        typeof createGroupedOrders
      >[0]['orders'],
      strategyOrderKind: StrategyOrderKind.Rfq,
    })

    const [params] = mocks.signCreateGroupedOrders.mock.calls[0] as unknown as [
      { orders: { clientOrderIndex: number }[] } & Record<string, unknown>,
    ]
    expect(params.orders.map((order) => order.clientOrderIndex)).toEqual([104, 100, 100])
    expect(params).not.toHaveProperty('strategyOrderKind')
  })
})
