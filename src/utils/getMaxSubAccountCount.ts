import type { ExtendedUserTier } from '../types/user-tiers'
import { isRobinhoodEnv } from '../lib/env'

// Mirrors the BE UserTiers config (MaxSubAccountCount); sub-accounts and public
// pools both count toward the limit, the main account does not. Robinhood keeps
// DefaultMaxSubAccountCount.
export const MAX_SUB_ACCOUNTS_BY_TIER = {
  standard: 4,
  plus: 16,
  premium: 64,
} as const

const ROBINHOOD_MAX_SUB_ACCOUNT_COUNT = 8

export const getMaxSubAccountCount = (tier: ExtendedUserTier): number => {
  if (isRobinhoodEnv()) {
    return ROBINHOOD_MAX_SUB_ACCOUNT_COUNT
  }
  if (!tier || tier === 'standard') {
    return MAX_SUB_ACCOUNTS_BY_TIER.standard
  }
  return tier === 'plus' ? MAX_SUB_ACCOUNTS_BY_TIER.plus : MAX_SUB_ACCOUNTS_BY_TIER.premium
}
