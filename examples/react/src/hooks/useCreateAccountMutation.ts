import { useMutation, type UseMutationOptions } from '@tanstack/react-query'
import { apis, useUserAddress, wait } from 'lighter-ts'
import type { AccountRequest } from 'zklighter-perps'

export const useCreateAccountMutation = (
  options?: Omit<UseMutationOptions<void, Error, void, unknown>, 'mutationFn'>,
) => {
  const userAddress = useUserAddress()

  return useMutation({
    mutationFn: async () => {
      if (!userAddress) {
        console.error('User address is required for creating account')
        return
      }

      const params: AccountRequest = { by: 'l1_address', value: userAddress }
      let newAccount = await apis.accountApi.account(params).catch(() => null)

      while (!newAccount || newAccount.accounts.length === 0) {
        await wait(3000)
        newAccount = await apis.accountApi.account(params).catch(() => null)
      }
    },
    ...options,
  })
}
