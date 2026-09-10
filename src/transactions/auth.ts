import { transactionConfig } from '../lib/transactionConfig'
import type {
  CreateClientParams,
  PubKeySignParams,
  PubKeyTransactionParams,
} from '../types/signers'
import { TxTypes } from '../types/user'
import { handleAndSendTxResponse, sendTx } from './sendTx'

export const createClient = (request: CreateClientParams) =>
  transactionConfig.signers.createClient({
    ...request,
    skipNonce: request.skipNonce ?? transactionConfig.skipNonce,
  })

export const getChangePubKeyTransaction = (request: PubKeyTransactionParams) =>
  transactionConfig.signers.getChangePubKeyTransaction(request)

export const getRevokePubKeyTransaction = (request: PubKeyTransactionParams) =>
  transactionConfig.signers.getRevokePubKeyTransaction(request)

export const changePubKey = async ({
  skipConfirmation,
  ...request
}: PubKeySignParams & { skipConfirmation?: boolean }) => {
  const txResponse = await transactionConfig.signers.signChangePubKey(request)

  if (skipConfirmation) {
    return sendTx(TxTypes.TxTypeL2ChangePubKey, txResponse)
  }

  return handleAndSendTxResponse(TxTypes.TxTypeL2ChangePubKey, txResponse)
}

export const revokePubKey = async (request: PubKeySignParams) => {
  const txResponse = await transactionConfig.signers.signRevokePubKey(request)

  return handleAndSendTxResponse(TxTypes.TxTypeL2ChangePubKey, txResponse)
}
