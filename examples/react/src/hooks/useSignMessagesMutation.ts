import { useMutation, type UseMutationOptions } from '@tanstack/react-query'
import type { RefObject } from 'react'
import { LIGHTER_CHAIN_ID } from '../const/LIGHTER_CHAIN_ID'
import { createClient, getNonce, wait } from 'lighter-ts'
import { initWASM } from '../lib'

interface SignMessagesMutationParams {
  accountIndex: number
  apiKeyIndex: number
  cancelRef?: RefObject<boolean>
  useL1?: boolean
  isEmbeddedWallet?: boolean
  singleSignature?: boolean
}

interface SignMessagesMutationResponse {
  pk: string
  body: string
  seed: string
  prv: string
  nonce: number
  useL1?: boolean
}

export const useSignMessagesMutation = (
  options?: Omit<
    UseMutationOptions<SignMessagesMutationResponse, Error, SignMessagesMutationParams, unknown>,
    'mutationFn'
  >,
) => {
  return useMutation({
    mutationFn: async ({ accountIndex, apiKeyIndex, cancelRef, useL1, isEmbeddedWallet }) => {
      if (isEmbeddedWallet) {
        await wait(250)
      }

      if (!window || !window.crypto) {
        throw new Error('Crypto not available')
      }

      let newSeed: string
      newSeed = Array.from(window.crypto.getRandomValues(new Uint8Array(132)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      const nonce = await getNonce(accountIndex, apiKeyIndex).catch(() => null)

      if (nonce === null) {
        throw new Error('Nonce is null')
      }

      if (cancelRef?.current) {
        throw new Error('Canceled sign message')
      }

      // initialize WASM with private key
      await initWASM()
      const clientResData = await createClient({
        seed: newSeed,
        chainId: LIGHTER_CHAIN_ID,
        accountIndex,
        nonce,
        apiKeyIndex,
      })

      return { ...clientResData, seed: newSeed, nonce, useL1 }
    },
    ...options,
  })
}
