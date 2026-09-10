import {
  selectAccountExistence,
  selectL1Initialized,
  selectUserAccountIndex,
  useAccountsQuery,
  useLighterStore,
  useUserAddress,
  type AccountExistence,
} from 'lighter-ts'
import { useIsRegisteredQuery } from './useIsRegisteredQuery'
import { useEffect } from 'react'

const useAccountExistence = (): AccountExistence => {
  const userAddress = useUserAddress()
  const l1Initialized = useLighterStore(selectL1Initialized)
  const accountIndex = useLighterStore(selectUserAccountIndex)
  const accountsQuery = useAccountsQuery()
  const hasCompletedDeposit = false
  const hasPendingDeposit = false
  const hasNoDeposits = true
  const isDepositsLoading = false
  const isRegistered = useIsRegisteredQuery().data

  if (!l1Initialized) return 'Deciding'
  if (!userAddress) return 'NoWallet'
  if (accountsQuery.isPending) return 'Deciding'

  if (
    (!accountIndex && accountsQuery.isSuccess) ||
    (accountsQuery.isError && accountsQuery.error?.response?.status !== 400)
  )
    return 'Deciding'

  if (!accountIndex) {
    if (isDepositsLoading) return 'Deciding'
    if (hasCompletedDeposit) return 'Creating'
    if (hasPendingDeposit) return 'DepositInProgress'
    if (hasNoDeposits) return 'ShouldDeposit'
    return 'Deciding'
  }

  if (isRegistered === null) return 'Deciding'
  if (isRegistered === false) return 'KeysDontMatch'

  return 'Exists'
}

export const useSyncAccountExistence = () => {
  const accountExistence = useAccountExistence()

  useEffect(() => {
    useLighterStore.setState({ accountExistence })
  }, [accountExistence])
}

export const useIsAuthenticated = () => useLighterStore(selectAccountExistence) === 'Exists'
