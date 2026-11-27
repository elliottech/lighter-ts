import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FetchError } from 'zklighter-perps'

import { TX_LOOKUP_ATTEMPTS, TX_LOOKUP_TIMEOUT, TX_TIMEOUT } from '../constants/order'
import { TX_STATUSES } from '../constants/shared'
import type { Tx } from '../store/types'
import { ApiError } from '../types/ApiError'
import { TxTypes } from '../types/user'
import { handleAndSendTxResponse, isTxTimeoutError } from './sendTx'

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(),
  tx: vi.fn(),
}))

vi.mock('../lib/apis', () => ({
  apis: { transactionApi: { sendTx: mocks.sendTx, tx: mocks.tx } },
}))
vi.mock('../ws-sub-store/utils', () => ({
  subscribeToAccountTx: vi.fn(),
  unsubscribeToAccountTx: vi.fn(),
}))
vi.mock('../lib/errorReporting', () => ({
  errorReporting: { captureException: vi.fn() },
}))

// A half-open HTTP connection: the request is accepted by fetch but never answers.
const never = () => new Promise<never>(() => {})

describe('handleAndSendTxResponse when REST stops answering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.sendTx.mockImplementation(never)
    mocks.tx.mockImplementation(never)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('settles even when sendTx and the hash lookup both hang', async () => {
    let settled = false
    const pending = handleAndSendTxResponse(TxTypes.TxTypeL2CreateOrder, {
      txHash: 'h',
      txInfo: '{}',
    })
    pending.then(
      () => (settled = true),
      () => (settled = true),
    )

    // No account_tx update arrives over the socket, so the fallback lookup runs.
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT * 10)

    expect(mocks.tx).toHaveBeenCalledTimes(TX_LOOKUP_ATTEMPTS)
    expect(mocks.tx).toHaveBeenCalledWith(
      { by: 'hash', value: 'h' },
      { signal: expect.any(AbortSignal) as AbortSignal },
    )
    expect(settled).toBe(true)
  })
})

describe('handleAndSendTxResponse lookup retries', () => {
  const executed = { hash: 'h', status: TX_STATUSES.StatusExecuted, event_info: '{}' } as Tx
  const pending = { ...executed, status: TX_STATUSES.StatusPending } as Tx

  const send = () => {
    const result: { value?: unknown; error?: unknown } = {}
    handleAndSendTxResponse(TxTypes.TxTypeL2CreateOrder, { txHash: 'h', txInfo: '{}' }).then(
      (value) => (result.value = value),
      (error: unknown) => (result.error = error),
    )
    return result
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.sendTx.mockImplementation(never)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('tries the lookup again after a failed one', async () => {
    mocks.tx.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(executed)

    const result = send()
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT * 10)

    expect(mocks.tx).toHaveBeenCalledTimes(2)
    expect(result.value).toBe(executed)
  })

  it('looks a pending tx up again until it executes', async () => {
    mocks.tx.mockResolvedValueOnce(pending).mockResolvedValueOnce(executed)

    const result = send()
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT * 10)

    expect(mocks.tx).toHaveBeenCalledTimes(2)
    expect(result.value).toBe(executed)
  })

  it('times out once every attempt has failed', async () => {
    mocks.tx.mockRejectedValue(new Error('network down'))

    const result = send()
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT * 10)

    expect(mocks.tx).toHaveBeenCalledTimes(TX_LOOKUP_ATTEMPTS)
    expect(isTxTimeoutError(result.error)).toBe(true)
  })
})

describe('handleAndSendTxResponse when the send gets no response', () => {
  const executed = { hash: 'h', status: TX_STATUSES.StatusExecuted, event_info: '{}' } as Tx
  const networkError = () => new FetchError(new TypeError('Network request failed'))

  const send = () => {
    const result: { value?: unknown; error?: unknown } = {}
    handleAndSendTxResponse(TxTypes.TxTypeL2CreateOrder, { txHash: 'h', txInfo: '{}' }).then(
      (value) => (result.value = value),
      (error: unknown) => (result.error = error),
    )
    return result
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    // A once-value a test left unused would otherwise answer the next test's lookup.
    mocks.sendTx.mockReset()
    mocks.tx.mockReset()
  })

  it('looks the tx up instead of failing when the send fails on the network', async () => {
    mocks.sendTx.mockRejectedValueOnce(networkError())
    mocks.tx.mockResolvedValueOnce(executed)

    const result = send()
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT - 1)
    expect(result).toEqual({})

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.tx).toHaveBeenCalledTimes(1)
    expect(result.value).toBe(executed)
  })

  it('keeps the lookup result when the send fails while the lookup runs', async () => {
    mocks.sendTx.mockImplementationOnce(
      () => new Promise((_, reject) => setTimeout(() => reject(networkError()), TX_TIMEOUT + 1000)),
    )
    mocks.tx.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(executed), 2000)),
    )

    const result = send()
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT + 3000)

    expect(result.error).toBeUndefined()
    expect(result.value).toBe(executed)
  })

  it('still fails at once when the server rejects the send', async () => {
    mocks.sendTx.mockRejectedValueOnce({
      response: {
        status: 400,
        json: () => Promise.resolve({ code: 21700, message: 'invalid order index' }),
      },
    })

    const result = send()
    await vi.advanceTimersByTimeAsync(0)

    expect(result.error).toBeInstanceOf(ApiError)
    expect(mocks.tx).not.toHaveBeenCalled()
  })

  it('aborts a lookup request that runs past its timeout', async () => {
    mocks.sendTx.mockImplementation(never)
    const signals: AbortSignal[] = []
    mocks.tx.mockImplementation((_: unknown, init: { signal: AbortSignal }) => {
      signals.push(init.signal)
      return never()
    })

    send()
    await vi.advanceTimersByTimeAsync(TX_TIMEOUT + TX_LOOKUP_TIMEOUT - 1)
    expect(signals[0]?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0]?.aborted).toBe(true)
  })
})
