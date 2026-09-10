import { SubAccountType } from '../store/types'
import { useUserAccount } from './useUserAccount'

export const useIsPoolAccount = () => {
  const userAccount = useUserAccount()
  return (
    userAccount?.account_type === SubAccountType.LighterPublic ||
    userAccount?.account_type === SubAccountType.Public
  )
}
