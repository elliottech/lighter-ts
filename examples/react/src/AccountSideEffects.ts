import { useInitAccountLimits } from 'lighter-ts'
import { useInitWs } from './hooks/useInitWs'
import { useSyncAccountExistence } from './hooks/useSyncAccountExistence'
import { useAccount } from './hooks/useAccount'

const AccountSideEffects = () => {
  useAccount()
  useInitAccountLimits()
  useInitWs()
  useSyncAccountExistence()

  return null
}

export default AccountSideEffects
