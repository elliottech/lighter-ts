import { TX_TIMEOUT } from '../constants/order'
import { TX_STATUSES } from '../constants/shared'
import { apis } from '../lib/apis'
import { errorReporting } from '../lib/errorReporting'
import { transactionConfig } from '../lib/transactionConfig'
import type { Tx } from '../store/types'
import type { TxEventInfo } from '../types/api-types'
import { ApiError } from '../types/ApiError'
import type { TxResponse } from '../types/order'
import type { TxTypes } from '../types/user'
import { parseErrorFromCodegen } from '../utils/parseErrorFromCodegen'
import { parseRequestBodyToFormData } from '../utils/parseRequestBodyToFormData'
import { subscribeToAccountTx, unsubscribeToAccountTx } from '../ws-sub-store/utils'
import { getNonce } from './getNonce'

export const INVALID_NONCE_CODE = 21104
export const MAX_NONCE_RETRIES = 3

export const handleTxError = (
  error: string | Error,
  txHash: string,
  additionalTags?: Record<string, string | number>,
) => {
  const errorObj = typeof error === 'string' ? new Error(error) : error
  errorReporting.captureException(errorObj, { tags: { txHash, ...additionalTags } })
  return errorObj
}

export const checkTxStatus = (
  tx: Tx,
  txHash: string,
): { isSuccess: true; error: null } | { isSuccess: false; error: Error } => {
  const { ae, code, message } = JSON.parse(tx.event_info) as TxEventInfo

  if (tx.status === TX_STATUSES.StatusFailed || !!ae) {
    let error: Error
    if (code && message) {
      error = new ApiError(message, code)
    } else {
      error = handleTxError(ae ?? 'Unknown error', txHash)
    }
    return { isSuccess: false, error }
  }

  return { isSuccess: true, error: null }
}

const parseErrorFromWebsocket = (error: unknown) => {
  try {
    const parsedError = JSON.parse((error as { message?: string }).message ?? '{}') as {
      code?: number
      message?: string
    }
    if (parsedError.code && parsedError.message) {
      return parsedError as { code: number; message: string }
    }
  } catch {
    errorReporting.captureException('Unknown websocket error', {
      tags: { error: String(error) },
    })
  }
  return error
}

export const handleAndSendTxResponse = (txType: TxTypes, { txHash, txInfo }: TxResponse) =>
  new Promise<Tx>((resolve, reject) => {
    const timeoutId = setTimeout(async () => {
      unsubscribeToAccountTx(callback)

      try {
        const tx = await apis.transactionApi.tx({ by: 'hash', value: txHash })
        const { isSuccess, error } = checkTxStatus(tx, txHash)

        if (isSuccess) {
          resolve(tx)
        } else {
          reject(error)
        }
      } catch {
        const timeoutError = handleTxError('Tx Timeout', txHash)
        reject(timeoutError)
      }
    }, TX_TIMEOUT)

    const callback = async (tx: Tx) => {
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
          const parsedError = await parseErrorFromWebsocket(error)
          reject(parsedError)
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
  PubKey: string
  ExpiredAt: number
  Sig: string
  L1Sig: string
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
        const parsedTxInfo = JSON.parse(txInfo) as L2ChangePubKeyTxInfo
        extraTags = { ...extraTags, ...parsedTxInfo }
      }
      const error = handleTxError(new ApiError(message, code), txHash, extraTags)
      throw error
    })
  }
}
