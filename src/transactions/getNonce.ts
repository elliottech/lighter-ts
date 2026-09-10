import { apis } from '../lib/apis'
import { transactionConfig } from '../lib/transactionConfig'

const lastNonceByKey = new Map<string, number>()

const generateTimestampNonce = (accountIndex: number, apiKeyIndex: number) => {
  const key = `${accountIndex}:${apiKeyIndex}`
  let nonce = Date.now()
  const lastNonce = lastNonceByKey.get(key) ?? 0
  if (nonce <= lastNonce) {
    nonce = lastNonce + 1
  }
  lastNonceByKey.set(key, nonce)
  return nonce
}

export const getNonce = async (accountIndex: number, apiKeyIndex?: number) => {
  const finalApiKeyIndex = apiKeyIndex ?? transactionConfig.getApiKeyIndex()

  if (transactionConfig.skipNonce) {
    return generateTimestampNonce(accountIndex, finalApiKeyIndex)
  }

  const { nonce } = await apis.transactionApi.nextNonce({
    account_index: accountIndex,
    api_key_index: finalApiKeyIndex,
  })

  return nonce
}
