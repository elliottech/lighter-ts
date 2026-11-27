import { TX_TIMEOUT } from '../constants/order'
import { TX_STATUSES } from '../constants/shared'
import { apis } from '../lib/apis'
import { transactionConfig } from '../lib/transactionConfig'
import type { Tx } from '../store/types'
import { ApiError } from '../types/ApiError'
import type {
  CancelAllOrdersParams,
  CancelOrderParams,
  CreateOrderParams,
  GroupedOrderParams,
  ModifyOrderParams,
  OrderParams,
} from '../types/order'
import { StrategyOrderKind } from '../types/StrategyOrderKind'
import { TxTypes } from '../types/user'
import { hasCodegenResponse, parseErrorFromCodegen } from '../utils/parseErrorFromCodegen'
import { parseRequestBodyToFormData } from '../utils/parseRequestBodyToFormData'
import { subscribeToAccountTx, unsubscribeToAccountTx } from '../ws-sub-store/utils'
import { getNonce } from './getNonce'
import {
  INVALID_NONCE_CODE,
  MAX_NONCE_RETRIES,
  TxTimeoutError,
  checkTxStatus,
  handleTxError,
  lookupTxWithRetry,
  sendWithNonceRetry,
} from './sendTx'

const signCreateOrder = (params: CreateOrderParams & { nonce: number; clientOrderIndex: number }) =>
  transactionConfig.signers.signCreateOrder(params)

const signCancelOrder = (params: CancelOrderParams & { nonce: number }) =>
  transactionConfig.signers.signCancelOrder(params)

const signCancelAllOrders = (params: CancelAllOrdersParams & { nonce: number }) =>
  transactionConfig.signers.signCancelAllOrders(params)

const signModifyOrder = (params: ModifyOrderParams & { nonce: number }) =>
  transactionConfig.signers.signModifyOrder(params)

const signCreateGroupedOrders = (
  params: Omit<GroupedOrderParams, 'orders'> & {
    nonce: number
    orders: (CreateOrderParams & { clientOrderIndex: number })[]
  },
) => transactionConfig.signers.signCreateGroupedOrders(params)

export const createOrder = async ({
  strategyOrderKind = StrategyOrderKind.None,
  ...request
}: CreateOrderParams & { strategyOrderKind?: StrategyOrderKind }) => {
  const clientOrderIndex =
    request.clientOrderIndex ??
    (await transactionConfig.generateClientOrderIndex(strategyOrderKind))

  return sendWithNonceRetry(TxTypes.TxTypeL2CreateOrder, request.accountIndex, (nonce) =>
    signCreateOrder({ ...request, clientOrderIndex, nonce }),
  )
}

export const cancelOrder = async (request: CancelOrderParams) =>
  sendWithNonceRetry(TxTypes.TxTypeL2CancelOrder, request.accountIndex, (nonce) =>
    signCancelOrder({ ...request, nonce }),
  )

export const cancelAllOrders = async (request: CancelAllOrdersParams) =>
  sendWithNonceRetry(TxTypes.TxTypeL2CancelAllOrders, request.accountIndex, (nonce) =>
    signCancelAllOrders({ ...request, nonce }),
  )

export const modifyOrder = async (request: ModifyOrderParams) =>
  sendWithNonceRetry(TxTypes.TxTypeL2ModifyOrder, request.accountIndex, (nonce) =>
    signModifyOrder({ ...request, nonce }),
  )

export const createGroupedOrders = async ({
  accountIndex,
  orders,
  groupingType,
  integratorFees,
  strategyOrderKind = StrategyOrderKind.None,
}: GroupedOrderParams & { strategyOrderKind?: StrategyOrderKind }) => {
  const ordersWithClientOrderIndex: (CreateOrderParams & { clientOrderIndex: number })[] = []
  for (const [index, order] of orders.entries()) {
    const clientOrderIndex = await transactionConfig.generateClientOrderIndex(
      index === 0 ? strategyOrderKind : StrategyOrderKind.None,
    )
    ordersWithClientOrderIndex.push({ ...order, clientOrderIndex })
  }

  return sendWithNonceRetry(TxTypes.TxTypeL2CreateGroupedOrders, accountIndex, (nonce) =>
    signCreateGroupedOrders({
      nonce,
      accountIndex,
      groupingType,
      orders: ordersWithClientOrderIndex,
      integratorFees,
    }),
  )
}

const signOrderBatch = async (accountIndex: number, requests: OrderParams[]) => {
  let nonce = await getNonce(accountIndex)
  const txInfos: string[] = []
  const txHashes: string[] = []
  const txTypes: TxTypes[] = []

  for (const [index, request] of requests.entries()) {
    if (index > 0) {
      nonce = transactionConfig.skipNonce ? await getNonce(accountIndex) : nonce + 1
    }

    switch (request.type) {
      case 'create': {
        const clientOrderIndex = await transactionConfig.generateClientOrderIndex()
        const { txHash, txInfo } = await signCreateOrder({
          ...request.params,
          clientOrderIndex,
          nonce,
        })
        txTypes.push(TxTypes.TxTypeL2CreateOrder)
        txInfos.push(txInfo)
        txHashes.push(txHash)
        break
      }
      case 'cancel': {
        const { txHash, txInfo } = await signCancelOrder({ ...request.params, nonce })
        txTypes.push(TxTypes.TxTypeL2CancelOrder)
        txInfos.push(txInfo)
        txHashes.push(txHash)
        break
      }
      case 'modify': {
        const { txHash, txInfo } = await signModifyOrder({ ...request.params, nonce })
        txTypes.push(TxTypes.TxTypeL2ModifyOrder)
        txInfos.push(txInfo)
        txHashes.push(txHash)
        break
      }
    }
  }

  return { txInfos, txHashes, txTypes }
}

const sendOrderBatch = (txInfos: string[], txHashes: string[], txTypes: TxTypes[]) => {
  const txInfoStr = JSON.stringify(txInfos)
  const txTypeStr = JSON.stringify(txTypes)
  const txHashesStr = JSON.stringify(txHashes)

  const remainingTxHashes = new Set(txHashes)
  const txResponseByHash: Record<string, Tx | Error> = {}

  return new Promise<(Tx | Error)[]>((resolve, reject) => {
    const timeoutId = setTimeout(async () => {
      unsubscribeToAccountTx(callback)
      // Look the missing legs up in parallel, so the batch waits for one leg's
      // lookups at most rather than for every leg's in turn.
      await Promise.all(
        [...remainingTxHashes].map(async (txHash) => {
          try {
            const tx = await lookupTxWithRetry(txHash, (signal) =>
              apis.transactionApi.tx({ by: 'hash', value: txHash }, { signal }),
            )
            const { isSuccess, error } = checkTxStatus(tx, txHash)

            if (isSuccess) {
              txResponseByHash[txHash] = tx
            } else {
              txResponseByHash[txHash] = error
            }
          } catch {
            txResponseByHash[txHash] = new TxTimeoutError(txHash)
          }
        }),
      )

      resolve(txHashes.map((hash) => txResponseByHash[hash]!))
    }, TX_TIMEOUT)

    const callback = (tx: Tx) => {
      const { hash, status } = tx

      if (!remainingTxHashes.has(hash) || status === TX_STATUSES.StatusPending) {
        return
      }

      remainingTxHashes.delete(hash)

      const { isSuccess, error } = checkTxStatus(tx, hash)
      if (isSuccess) {
        txResponseByHash[hash] = tx
      } else {
        txResponseByHash[hash] = error
      }

      if (remainingTxHashes.size === 0) {
        clearTimeout(timeoutId)
        unsubscribeToAccountTx(callback)
        resolve(txHashes.map((hash) => txResponseByHash[hash]!))
      }
    }

    subscribeToAccountTx(callback)

    const params = { tx_infos: txInfoStr, tx_types: txTypeStr }

    apis.transactionApi
      .sendTxBatch(params, { body: parseRequestBodyToFormData(params) })
      .catch((e) => {
        // Without a response the batch may still have reached the server, so
        // the by-hash lookups after TX_TIMEOUT settle each leg instead.
        if (!hasCodegenResponse(e)) return

        clearTimeout(timeoutId)
        unsubscribeToAccountTx(callback)

        return parseErrorFromCodegen(e)
          .then(({ message, code }) => {
            const error = handleTxError(new ApiError(message, code), txHashesStr, {
              message,
            })
            reject(error)
          })
          .catch((e) => {
            reject(e)
          })
      })
  })
}

// Batches are atomic: if one tx hits an invalid nonce, sendTxBatch rejects the
// whole batch and nothing executes (the error surfaces here, not as a per-tx
// result). So, like sendWithNonceRetry, we can safely re-sign every tx with fresh
// nonces and resend the entire batch without risking duplicates.
export const createOrderBatch = async (
  accountIndex: number,
  requests: OrderParams[],
): Promise<(Tx | Error)[]> => {
  for (let attempt = 0; ; attempt++) {
    const { txInfos, txHashes, txTypes } = await signOrderBatch(accountIndex, requests)

    try {
      return await sendOrderBatch(txInfos, txHashes, txTypes)
    } catch (e) {
      const isInvalidNonce = e instanceof ApiError && e.code === INVALID_NONCE_CODE
      if (!transactionConfig.skipNonce || !isInvalidNonce || attempt >= MAX_NONCE_RETRIES) {
        throw e
      }
    }
  }
}
