import { signMessage as wagmiSignMessage } from '@wagmi/core'
import { useCallback } from 'react'
import { wagmiConfig } from '../wagmi'

export const useSignMessage = () => {
  return useCallback(async (message: string): Promise<string | undefined> => {
    return wagmiSignMessage(wagmiConfig, {
      message,
    })
  }, [])
}
