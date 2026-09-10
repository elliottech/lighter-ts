import { useCallback } from 'react'
import { isRegistered } from '../utils/isRegistered'
import { API_KEY_INDEXES, createClient } from 'lighter-ts'
import { readLSAccountSignature } from '../utils/auth-storage'
import { apis } from '../lib/apis'
import { initWASM } from '../lib'
import { LIGHTER_CHAIN_ID } from '../const/LIGHTER_CHAIN_ID'

export const useVerifyAccount = () => {
  return useCallback(async (accountIndex: number, forceRefresh?: boolean) => {
    try {
      if (isRegistered(accountIndex) && !forceRefresh) {
        return true
      }

      const apiKeyIndex = API_KEY_INDEXES.DESKTOP

      const storageAccount = readLSAccountSignature(accountIndex, apiKeyIndex)

      if (!storageAccount) {
        return false
      }

      const apiKey = await apis.accountApi
        .apikeys({ api_key_index: apiKeyIndex, account_index: accountIndex })
        .then(({ api_keys }) => api_keys[0]?.public_key)
        .catch(() => '')

      if (!apiKey || storageAccount.pk !== apiKey) {
        return false
      }

      await initWASM()
      await createClient({
        seed: storageAccount.seed,
        chainId: LIGHTER_CHAIN_ID,
        accountIndex,
        nonce: 0, // nonce is not used only used when initializing
        apiKeyIndex,
      })

      return true
    } catch (error) {
      console.error(error)
      return false
    }
  }, [])
}
