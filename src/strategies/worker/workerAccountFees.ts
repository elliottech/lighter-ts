import { AccountAccountTypeEnum } from 'zklighter-perps'
import {
  type IntegratorFees,
  type UserTier,
  apis,
  selectSystemConfig,
  selectUserTier,
  useLighterStore,
} from '../..'

import { getPaidActionFees } from '../../utils/getPaidFees'

export const ACCOUNT_LIMITS_REFRESH_MS = 5 * 60_000

const toUserTier = (userTier: string): UserTier =>
  userTier === 'premium' || userTier === 'plus' ? userTier : 'standard'

// Mirrors `useInitAccountLimits`: pools and the insurance fund are premium.
const loadUserTier = async (accountIndex: number, isPoolAccount: boolean): Promise<UserTier> => {
  if (isPoolAccount) return 'premium'
  const accountLimits = await apis.accountApi.accountLimits({
    account_index: accountIndex,
  })
  return toUserTier(accountLimits.user_tier)
}

// Mirrors `useIsPoolAccount`.
export const fetchIsPoolAccount = async (accountIndex: number): Promise<boolean> => {
  const { accounts } = await apis.accountApi.account({ by: 'index', value: String(accountIndex) })
  const account = accounts.find((entry) => entry.index === accountIndex)
  if (!account) throw new Error(`Account ${accountIndex} was not found`)
  return (
    account.account_type === AccountAccountTypeEnum.PublicPool ||
    account.account_type === AccountAccountTypeEnum.InsuranceFund
  )
}

let refreshedAccountIndex: number | null = null
let latestTierRequest = 0
let appliedTierRequest = 0

// A failed refresh keeps the last tier; a response older than the applied one is dropped.
const refreshUserTier = (accountIndex: number): Promise<void> => {
  const request = ++latestTierRequest
  return loadUserTier(accountIndex, false)
    .then((userTier) => {
      if (request < appliedTierRequest) return
      appliedTierRequest = request
      useLighterStore.setState({ userTier })
    })
    .catch(() => {})
}

// The worker store starts from the fallbacks (no tier, bundled system config);
// the main thread's init hooks do not run here. The tier is refreshed for the
// worker's lifetime so a mid-strategy change is billed like on main.
export const initWorkerAccountFees = async (
  accountIndex: number,
  isPoolAccount: boolean,
): Promise<void> => {
  const [systemConfig, userTier] = await Promise.all([
    apis.infoApi.systemConfig(),
    loadUserTier(accountIndex, isPoolAccount),
  ])
  useLighterStore.setState({ systemConfig, userTier })
  refreshedAccountIndex = isPoolAccount ? null : accountIndex
  if (isPoolAccount) return
  setInterval(() => refreshUserTier(accountIndex), ACCOUNT_LIMITS_REFRESH_MS)
}

/** Reloads the tier so a new strategy, or one running when the tier changed, is billed by the current one. */
export const refreshStrategyUserTier = (): Promise<void> =>
  refreshedAccountIndex === null ? Promise.resolve() : refreshUserTier(refreshedAccountIndex)

// Standard pays the integrator fee; Plus/Premium pay their tier's venue fees.
export const getStrategyIntegratorFees = (): IntegratorFees | undefined => {
  const lighterState = useLighterStore.getState()
  const userTier = selectUserTier(lighterState)
  if (!userTier) throw new Error('Account tier is not loaded')
  // The main thread prevents strategies from starting for blocked logins.
  return getPaidActionFees(userTier, selectSystemConfig(lighterState), {
    isBlocked: false,
    isQRLogin: false,
    isApproved: false,
  })
}
