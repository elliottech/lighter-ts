import { useQuery } from '@tanstack/react-query'
import { useVerifyAccount } from './useVerifyAccount'
import { useUserAccount } from 'lighter-ts'

export const useIsRegisteredQuery = () => {
  const verifyAccount = useVerifyAccount()
  const userAccount = useUserAccount()

  return useQuery({
    queryKey: ['isRegistered', userAccount?.index],
    queryFn: () => verifyAccount(userAccount!.index),
    initialData: null,
    enabled: !!userAccount,
    refetchInterval: (query) => {
      if (query.state.data === null && !!userAccount) {
        return 2000
      }

      return undefined
    },
  })
}
