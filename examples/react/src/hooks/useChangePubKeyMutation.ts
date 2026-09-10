import { useMutation, type UseMutationOptions } from '@tanstack/react-query'
import type { RefObject } from 'react'
import { apis } from '../lib'
import { API_KEY_INDEXES, changePubKey, useLighterStore, wait } from 'lighter-ts'
import { useSignMessage } from './useSignMessage'

interface ChangePubKeyMutationParams {
  apiKeyIndex: number
  shouldRefreshKey: boolean
  accountIndex: number
  message: string
  nonce: number
  pk: string
  seed: string
  useL1?: boolean
  cancelRef?: RefObject<boolean>
}

export const useChangePubKeyMutation = (
  options?: Omit<
    UseMutationOptions<void, Error, ChangePubKeyMutationParams, unknown>,
    'mutationFn'
  >,
) => {
  const signMessage = useSignMessage()

  return useMutation({
    mutationFn: async ({
      apiKeyIndex,
      shouldRefreshKey,
      accountIndex,
      message,
      nonce,
      pk,
      useL1,
      cancelRef,
    }) => {
      const apiKey = await apis.accountApi
        .apikeys({ api_key_index: apiKeyIndex, account_index: accountIndex })
        .then((a) => a.api_keys[0]?.public_key)
        .catch(() => '')

      if (apiKey === pk && !shouldRefreshKey) {
        return
      }

      if (useL1) {
        throw new Error('L1 change pub key not supported on example')
      } else {
        const signature = await signMessage(message)
        if (!signature) {
          throw new Error('Failed to sign message')
        }
        if (apiKeyIndex === API_KEY_INDEXES.DESKTOP) {
          useLighterStore.setState({ proof: { message, signature } })
        }
        await changePubKey({
          accountIndex,
          signature,
          nonce,
          apiKeyIndex,
          skipConfirmation: true,
        })
      }

      if (cancelRef?.current) {
        throw new Error('Canceled sign message')
      }

      let attempts = 0
      const maxAttempts = 30

      do {
        if (cancelRef?.current) {
          throw new Error('Canceled sign message')
        }
        await wait(useL1 ? 10000 : 2000)
        attempts++

        if (attempts >= maxAttempts) {
          break
        }
      } while (
        (await apis.accountApi
          .apikeys({ api_key_index: apiKeyIndex, account_index: accountIndex })
          .then((a) => a.api_keys[0]?.public_key)
          .catch(() => '')) !== pk
      )
    },
    ...options,
  })
}
