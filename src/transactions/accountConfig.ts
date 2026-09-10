import { transactionConfig } from '../lib/transactionConfig'
import type {
  UpdateAccountAssetConfigParams,
  UpdateAccountConfigParams,
  UpdateLeverageParams,
  UpdateMarginParams,
} from '../types/signers'
import { TxTypes } from '../types/user'
import { sendWithNonceRetry } from './sendTx'

export const updateMargin = async (request: UpdateMarginParams) =>
  sendWithNonceRetry(TxTypes.TxTypeL2UpdateMargin, request.accountIndex, (nonce) =>
    transactionConfig.signers.signUpdateMargin({ ...request, nonce }),
  )

export const updateLeverage = async (request: UpdateLeverageParams) =>
  sendWithNonceRetry(TxTypes.TxTypeL2UpdateLeverage, request.accountIndex, (nonce) =>
    transactionConfig.signers.signUpdateLeverage({ ...request, nonce }),
  )

export const updateAccountConfig = async (request: UpdateAccountConfigParams) =>
  sendWithNonceRetry(TxTypes.TxTypeL2UpdateAccountConfig, request.accountIndex, (nonce) =>
    transactionConfig.signers.signUpdateAccountConfig({ ...request, nonce }),
  )

export const updateAccountAssetConfig = async (request: UpdateAccountAssetConfigParams) =>
  sendWithNonceRetry(TxTypes.TxTypeL2UpdateAccountAssetConfig, request.accountIndex, (nonce) =>
    transactionConfig.signers.signUpdateAccountAssetConfig({ ...request, nonce }),
  )
