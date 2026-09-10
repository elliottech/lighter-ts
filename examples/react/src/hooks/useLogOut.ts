import { useQueryClient } from '@tanstack/react-query'
import { removeLSLastAccountIndex, removeLSSignature } from '../utils/auth-storage'
import { useLighterStore, useWsSubStore } from 'lighter-ts'
import { resetAuthToken } from '../utils/auth'
import { useDisconnect } from 'wagmi'

export const useLogOut = () => {
  const queryClient = useQueryClient()
  const { mutate: disconnect } = useDisconnect()

  const handleLogout = () => {
    queryClient.removeQueries({ queryKey: ['isRegistered'] })
    removeLSSignature()
    removeLSLastAccountIndex()
    useLighterStore.setState({
      accountIndex: 0,
      accountExistence: 'NoWallet',
      l1Address: '',
      userTier: null,
      accountTradingMode: null,
    })
    resetAuthToken()
    useWsSubStore.getState().actions.logout()
    queryClient.removeQueries({ queryKey: ['account'], exact: false })
    disconnect()
  }
  return handleLogout
}
