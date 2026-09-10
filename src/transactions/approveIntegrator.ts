import { transactionConfig } from '../lib/transactionConfig'
import type {
  PrepareApproveIntegratorRequestParams,
  PreparedApproveIntegratorRequest,
} from '../types/signers'
import { TxTypes } from '../types/user'
import { getNonce } from './getNonce'
import { handleAndSendTxResponse } from './sendTx'

export const prepareApproveIntegratorRequest = async ({
  signMessage,
  ...request
}: PrepareApproveIntegratorRequestParams): Promise<PreparedApproveIntegratorRequest> => {
  const apiKeyIndex = transactionConfig.getApiKeyIndex()
  const nonce = await getNonce(request.accountIndex)

  const { body } = await transactionConfig.signers.getApproveIntegratorTransaction({
    ...request,
    nonce,
    apiKeyIndex,
  })

  const signature = await signMessage(body)
  if (!signature) {
    throw new Error('Failed to sign message')
  }

  return { ...request, signature, nonce, apiKeyIndex }
}

export const approveIntegrator = async (request: PreparedApproveIntegratorRequest) => {
  const txResponse = await transactionConfig.signers.signApproveIntegrator(request)

  return handleAndSendTxResponse(TxTypes.TxTypeL2ApproveIntegrator, txResponse)
}
