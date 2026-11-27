import {
  TX_LOOKUP_ATTEMPTS,
  TX_LOOKUP_RETRY_DELAY,
  TX_LOOKUP_TIMEOUT,
  TX_TIMEOUT,
} from '../constants/order'
import { TX_STATUSES } from '../constants/shared'
import { apis } from '../lib/apis'
import { errorReporting } from '../lib/errorReporting'
import { transactionConfig } from '../lib/transactionConfig'
import type { Tx } from '../store/types'
import type { TxEventInfo } from '../types/api-types'
import { ApiError } from '../types/ApiError'
import type { TxResponse } from '../types/order'
import type { TxTypes } from '../types/user'
import { hasCodegenResponse, parseErrorFromCodegen } from '../utils/parseErrorFromCodegen'
import { parseRequestBodyToFormData } from '../utils/parseRequestBodyToFormData'
import { subscribeToAccountTx, unsubscribeToAccountTx } from '../ws-sub-store/utils'
import { getNonce } from './getNonce'

export const INVALID_NONCE_CODE = 21104
export const MAX_NONCE_RETRIES = 3
// The order is no longer on the book: it filled, was cancelled or expired before the tx executed.
export const INVALID_ORDER_INDEX_CODE = 21700

export const isInvalidOrderIndexError = (error: unknown) =>
  error instanceof ApiError && error.code === INVALID_ORDER_INDEX_CODE

// The tx was neither confirmed nor found by hash in time. It can still execute until its ExpiredAt.
export class TxTimeoutError extends Error {
  constructor(public txHash: string) {
    super('Tx Timeout')
    Object.setPrototypeOf(this, TxTimeoutError.prototype)
  }
}

export const isTxTimeoutError = (error: unknown): error is TxTimeoutError =>
  error instanceof TxTimeoutError

const ORDER_COUNT_LIMIT_CODES = new Set([21717, 21718, 21719, 21720])

const isOrderCountLimitError = (error: Error) =>
  error instanceof ApiError && error.code !== undefined && ORDER_COUNT_LIMIT_CODES.has(error.code)

export const handleTxError = (
  error: string | Error,
  txHash: string,
  additionalTags?: Record<string, string | number>,
) => {
  const errorObj = typeof error === 'string' ? new Error(error) : error
  if (!isOrderCountLimitError(errorObj)) {
    errorReporting.captureException(errorObj, { tags: { txHash, ...additionalTags } })
  }
  return errorObj
}

// `ae` carries the backend error as JSON, e.g. {"code":21700,"message":"invalid order index"}
const parseAppError = (ae?: string): { code: number; message: string } | null => {
  if (!ae) return null
  try {
    const { code, message } = JSON.parse(ae) as { code?: unknown; message?: unknown }
    if (typeof code === 'number' && typeof message === 'string') return { code, message }
  } catch {
    // plain-string app error
  }
  return null
}

export const checkTxStatus = (
  tx: Tx,
  txHash: string,
): { isSuccess: true; error: null } | { isSuccess: false; error: Error } => {
  const { ae, code, message } = JSON.parse(tx.event_info) as TxEventInfo

  if (tx.status === TX_STATUSES.StatusFailed || !!ae) {
    const appError = code && message ? { code, message } : parseAppError(ae)
    const error = appError
      ? new ApiError(appError.message, appError.code)
      : handleTxError(ae ?? 'Unknown error', txHash)
    return { isSuccess: false, error }
  }

  return { isSuccess: true, error: null }
}

// fetch has no timeout of its own, and after a network drop the request can sit
// on a dead connection indefinitely. Without a bound here the tx promise never
// settles and the caller's pending state never clears. The request is aborted
// too, so a retry is not queued behind it on the same dead connection.
export const withTxLookupTimeout = (txHash: string, lookup: (signal: AbortSignal) => Promise<Tx>) =>
  new Promise<Tx>((resolve, reject) => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => {
      controller.abort()
      reject(new TxTimeoutError(txHash))
    }, TX_LOOKUP_TIMEOUT)
    lookup(controller.signal)
      .then(resolve, reject)
      .finally(() => clearTimeout(timeoutId))
  })

// A lookup can fail, time out or find the tx still pending. Each of those is
// worth another try. The last attempt's result is used as it is.
export const lookupTxWithRetry = async (
  txHash: string,
  lookup: (signal: AbortSignal) => Promise<Tx>,
) => {
  for (let attempt = 1; ; attempt++) {
    const isLastAttempt = attempt >= TX_LOOKUP_ATTEMPTS
    try {
      const tx = await withTxLookupTimeout(txHash, lookup)
      if (tx.status !== TX_STATUSES.StatusPending || isLastAttempt) return tx
    } catch (e) {
      if (isLastAttempt) throw e
    }
    await new Promise((resolve) => setTimeout(resolve, TX_LOOKUP_RETRY_DELAY))
  }
}

export const handleAndSendTxResponse = (txType: TxTypes, { txHash, txInfo }: TxResponse) =>
  new Promise<Tx>((resolve, reject) => {
    const timeoutId = setTimeout(async () => {
      unsubscribeToAccountTx(callback)

      try {
        const tx = await lookupTxWithRetry(txHash, (signal) =>
          apis.transactionApi.tx({ by: 'hash', value: txHash }, { signal }),
        )
        const { isSuccess, error } = checkTxStatus(tx, txHash)

        if (isSuccess) {
          resolve(tx)
        } else {
          reject(error)
        }
      } catch {
        const timeoutError = handleTxError(new TxTimeoutError(txHash), txHash)
        reject(timeoutError)
      }
    }, TX_TIMEOUT)

    const callback = (tx: Tx) => {
      const { hash, status } = tx

      if (hash !== txHash || status === TX_STATUSES.StatusPending) {
        return
      }

      clearTimeout(timeoutId)
      unsubscribeToAccountTx(callback)

      try {
        const { isSuccess, error } = checkTxStatus(tx, txHash)

        if (isSuccess) {
          resolve(tx)
        } else {
          reject(error)
        }
      } catch (e) {
        reject(e)
      }
    }

    subscribeToAccountTx(callback)

    const reqBody = { tx_type: txType, tx_info: txInfo, price_protection: false }

    apis.transactionApi
      .sendTx(reqBody, { body: parseRequestBodyToFormData(reqBody) })
      .catch((e) => {
        // Without a response the tx may still have reached the server, so the
        // by-hash lookup after TX_TIMEOUT settles it instead.
        if (!hasCodegenResponse(e)) return

        clearTimeout(timeoutId)
        unsubscribeToAccountTx(callback)

        return parseErrorFromCodegen(e)
          .then(({ message, code }) =>
            reject(handleTxError(new ApiError(message, code), txHash, { message })),
          )
          .catch(reject)
      })
  })

// In skip-nonce mode a tx can lose a nonce race: concurrent txs on the same
// account get processed out of order and the backend advances the nonce floor
// to the highest accepted nonce, so a lower (earlier-generated) nonce that lands
// later is rejected as invalid. The tx never executed, so we re-sign with a
// fresh, higher timestamp nonce and resend.
export const sendWithNonceRetry = async (
  txType: TxTypes,
  accountIndex: number,
  sign: (nonce: number) => Promise<TxResponse>,
): Promise<Tx> => {
  for (let attempt = 0; ; attempt++) {
    const nonce = await getNonce(accountIndex)
    const txResponse = await sign(nonce)

    try {
      return await handleAndSendTxResponse(txType, txResponse)
    } catch (e) {
      const isInvalidNonce = e instanceof ApiError && e.code === INVALID_NONCE_CODE
      if (!transactionConfig.skipNonce || !isInvalidNonce || attempt >= MAX_NONCE_RETRIES) {
        throw e
      }
    }
  }
}

type L2ChangePubKeyTxInfo = {
  AccountIndex: number
  ApiKeyIndex: number
  Nonce: number
  ExpiredAt: number
}

const getChangePubKeyErrorTags = (txInfo: string): Record<string, number> => {
  const { AccountIndex, ApiKeyIndex, Nonce, ExpiredAt } = JSON.parse(txInfo) as L2ChangePubKeyTxInfo
  return { AccountIndex, ApiKeyIndex, Nonce, ExpiredAt }
}

export const sendTx = async (txType: TxTypes, { txHash, txInfo }: TxResponse) => {
  const reqBody = { tx_type: txType, tx_info: txInfo, price_protection: false }
  try {
    return await apis.transactionApi.sendTx(reqBody, {
      body: parseRequestBodyToFormData(reqBody),
    })
  } catch (e) {
    return parseErrorFromCodegen(e).then(({ message, code }) => {
      let extraTags: Record<string, string | number> = { message, code }
      if (code === 21504 || code === 21120) {
        extraTags = { ...extraTags, ...getChangePubKeyErrorTags(txInfo) }
      }
      const error = handleTxError(new ApiError(message, code), txHash, extraTags)
      throw error
    })
  }
}
