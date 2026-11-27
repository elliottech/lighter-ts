import { shouldUseECDSA } from '../lib/env'
import { transactionConfig } from '../lib/transactionConfig'
import type {
  CreateClientParams,
  PubKeySignParams,
  PubKeyTransactionParams,
} from '../types/signers'
import { TxTypes } from '../types/user'
import { handleAndSendTxResponse, sendTx } from './sendTx'

export const getECDSAPubKeyExpiredAt = () => Date.now() + 10 * 60 * 1000

export const getChangePubKeyTxType = () =>
  shouldUseECDSA() ? TxTypes.TxTypeL2ChangeECDSAPubKey : TxTypes.TxTypeL2ChangePubKey

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
    return sendTx(getChangePubKeyTxType(), txResponse)
  }

  return handleAndSendTxResponse(getChangePubKeyTxType(), txResponse)
}

export const revokePubKey = async (request: PubKeySignParams) => {
  const txResponse = await transactionConfig.signers.signRevokePubKey(request)

  return handleAndSendTxResponse(getChangePubKeyTxType(), txResponse)
}
