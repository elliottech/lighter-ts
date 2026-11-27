import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tx } from '../store/types'
import { ApiError } from '../types/ApiError'
import { TxTypes } from '../types/user'
import {
  TX_LOOKUP_ATTEMPTS,
  TX_LOOKUP_RETRY_DELAY,
  TX_LOOKUP_TIMEOUT,
  TX_TIMEOUT,
} from '../constants/order'
import {
  TxTimeoutError,
  checkTxStatus,
  handleAndSendTxResponse,
  isInvalidOrderIndexError,
  isTxTimeoutError,
  sendTx,
} from './sendTx'

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(),
  tx: vi.fn(),
  txCallbacks: [] as ((tx: unknown) => void)[],
  captureException: vi.fn<(exception: unknown, hint?: unknown) => string>(),
}))

vi.mock('../lib/apis', () => ({
  apis: { transactionApi: { sendTx: mocks.sendTx, tx: mocks.tx } },
}))
vi.mock('../ws-sub-store/utils', () => ({
  subscribeToAccountTx: (callback: (tx: unknown) => void) => mocks.txCallbacks.push(callback),
  unsubscribeToAccountTx: vi.fn(),
}))
vi.mock('../lib/errorReporting', () => ({
  errorReporting: { captureException: mocks.captureException },
}))

const rejectWith = (code: number, message: string) =>
  mocks.sendTx.mockRejectedValueOnce({
    response: { status: 400, json: () => Promise.resolve({ code, message }) },
  })

const txInfo = JSON.stringify({
  AccountIndex: 7,
  ApiKeyIndex: 3,
  Nonce: 11,
  PubKey: 'deadbeef',
  ExpiredAt: 1_700_000_000,
  Sig: 'signature-bytes',
  L1Sig: '0xl1signature',
})

describe('sendTx error reporting', () => {
  afterEach(() => vi.clearAllMocks())

  it('reports a failed L2ChangePubKey without the signed payload', async () => {
    rejectWith(21504, 'invalid signature')

    await expect(sendTx(TxTypes.TxTypeL2ChangePubKey, { txHash: 'h', txInfo })).rejects.toThrow(
      'invalid signature',
    )

    expect(mocks.captureException).toHaveBeenCalledTimes(1)
    const hint = mocks.captureException.mock.calls[0]?.[1]
    const tags = (hint as { tags: Record<string, unknown> }).tags
    expect(tags).toEqual({
      txHash: 'h',
      message: 'invalid signature',
      code: 21504,
      AccountIndex: 7,
      ApiKeyIndex: 3,
      Nonce: 11,
      ExpiredAt: 1_700_000_000,
    })
    expect(JSON.stringify(hint)).not.toMatch(/signature-bytes|0xl1signature|deadbeef/)
  })

  it('does not parse the tx payload for other error codes', async () => {
    rejectWith(21104, 'invalid nonce')

    await expect(
      sendTx(TxTypes.TxTypeL2ChangePubKey, { txHash: 'h', txInfo: 'not-json' }),
    ).rejects.toThrow('invalid nonce')

    const hint = mocks.captureException.mock.calls[0]?.[1]
    expect((hint as { tags: Record<string, unknown> }).tags).toEqual({
      txHash: 'h',
      message: 'invalid nonce',
      code: 21104,
    })
  })

  it.each([21717, 21718, 21719, 21720])(
    'does not report order-count limit code %i',
    async (code) => {
      rejectWith(code, 'maximum pending order count reached')

      await expect(
        sendTx(TxTypes.TxTypeL2CreateOrder, { txHash: 'h', txInfo }),
      ).rejects.toMatchObject({ code })

      expect(mocks.captureException).not.toHaveBeenCalled()
    },
  )
})

describe('checkTxStatus', () => {
  afterEach(() => vi.clearAllMocks())

  const failedTx = (eventInfo: Record<string, unknown>) =>
    ({ status: 3, event_info: JSON.stringify(eventInfo) }) as unknown as Tx

  it('returns a JSON app error as an unreported ApiError', () => {
    const { error } = checkTxStatus(
      failedTx({ ae: JSON.stringify({ code: 21700, message: 'invalid order index' }) }),
      'h',
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 21700, message: 'invalid order index' })
    expect(isInvalidOrderIndexError(error)).toBe(true)
    expect(mocks.captureException).not.toHaveBeenCalled()
  })

  it('reports a plain-string app error', () => {
    const { error } = checkTxStatus(failedTx({ ae: 'something broke' }), 'h')

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('something broke')
    expect(isInvalidOrderIndexError(error)).toBe(false)
    expect(mocks.captureException).toHaveBeenCalledTimes(1)
  })
})

describe('handleAndSendTxResponse', () => {
  afterEach(() => {
    vi.clearAllMocks()
    mocks.txCallbacks.length = 0
  })

  it('rejects with an ApiError when the websocket delivers a JSON app error', async () => {
    mocks.sendTx.mockResolvedValueOnce({})
    const pending = handleAndSendTxResponse(TxTypes.TxTypeL2CancelOrder, { txHash: 'h', txInfo })

    mocks.txCallbacks[0]?.({
      hash: 'h',
      status: 3,
      event_info: JSON.stringify({
        ae: JSON.stringify({ code: 21700, message: 'invalid order index' }),
      }),
    })

    const error: unknown = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(isInvalidOrderIndexError(error)).toBe(true)
    expect(mocks.captureException).not.toHaveBeenCalled()
  })
})

describe('handleAndSendTxResponse timeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.txCallbacks.length = 0
  })

  const timeOut = async () => {
    mocks.sendTx.mockResolvedValueOnce({})
    const pending = handleAndSendTxResponse(TxTypes.TxTypeL2CreateOrder, { txHash: 'h', txInfo })
    const settled = pending.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(
      TX_TIMEOUT +
        TX_LOOKUP_ATTEMPTS * TX_LOOKUP_TIMEOUT +
        (TX_LOOKUP_ATTEMPTS - 1) * TX_LOOKUP_RETRY_DELAY,
    )
    return settled
  }

  it('rejects with a recognisable timeout when the tx cannot be looked up', async () => {
    mocks.tx.mockRejectedValue(new Error('network down'))

    const error = await timeOut()

    expect(mocks.tx).toHaveBeenCalledTimes(TX_LOOKUP_ATTEMPTS)

    expect(isTxTimeoutError(error)).toBe(true)
    expect(error).toBeInstanceOf(TxTimeoutError)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Tx Timeout')
    expect((error as Error).name).toBe('Error')
    expect((error as TxTimeoutError).txHash).toBe('h')
    expect(mocks.captureException).toHaveBeenCalledTimes(1)
    expect(mocks.captureException.mock.calls[0]).toEqual([error, { tags: { txHash: 'h' } }])
  })

  it('does not treat a failed tx found by hash as a timeout', async () => {
    mocks.tx.mockResolvedValueOnce({
      hash: 'h',
      status: 3,
      event_info: JSON.stringify({
        ae: JSON.stringify({ code: 21700, message: 'invalid order index' }),
      }),
    })

    const error = await timeOut()

    expect(error).toBeInstanceOf(ApiError)
    expect(isTxTimeoutError(error)).toBe(false)
  })

  it('does not recognise a plain error with the same message', () => {
    expect(isTxTimeoutError(new Error('Tx Timeout'))).toBe(false)
    expect(isTxTimeoutError(undefined)).toBe(false)
  })
})
