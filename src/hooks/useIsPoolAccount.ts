import { AccountAccountTypeEnum } from 'zklighter-perps'
import { useUserAccount } from './useUserAccount'

export const useIsPoolAccount = () => {
  const userAccount = useUserAccount()
  return (
    userAccount?.account_type === AccountAccountTypeEnum.InsuranceFund ||
    userAccount?.account_type === AccountAccountTypeEnum.PublicPool
  )
}
