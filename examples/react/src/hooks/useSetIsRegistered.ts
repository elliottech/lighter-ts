import { useQueryClient } from '@tanstack/react-query'

export const useSetIsRegistered = () => {
  const queryClient = useQueryClient()

  return (accountIndex: number, value: boolean) =>
    queryClient.setQueryData(['isRegistered', accountIndex], value)
}
