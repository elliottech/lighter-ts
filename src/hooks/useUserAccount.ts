import type { UseQueryOptions } from '@tanstack/react-query'
import type { ResponseError } from 'zklighter-perps'
import { useAccountsQuery, type AccountsQueryData } from './useAccountsQuery'
import { useLighterStore } from '../store/useLighterStore'
import { selectUserAccountIndex } from '../store/user/selectors'

export const useUserAccount = (
  options?: Omit<UseQueryOptions<AccountsQueryData, ResponseError>, 'queryKey' | 'queryFn'>,
) => {
  const accountIndex = useLighterStore(selectUserAccountIndex)
  const accountsQuery = useAccountsQuery(options)

  return accountsQuery.data?.accountsByIndex[accountIndex]
}
