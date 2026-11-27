import type { FeeTiers, UserFeeTier } from 'zklighter-perps'

export type UserTier = 'standard' | 'premium' | 'plus' | null

export type ExtendedUserTier =
  | UserTier
  | 'premium_1'
  | 'premium_2'
  | 'premium_3'
  | 'premium_4'
  | 'premium_5'
  | 'premium_6'
  | 'premium_7'

// The SDK declares these on UserFeeTier, but mainnet doesn't send them yet.
type TierLimitField =
  | 'twap_fee_ticks'
  | 'taker_latency_ms'
  | 'send_tx_rate_limit'
  | 'max_sub_accounts'

export type BackendFeeTier = Omit<UserFeeTier, TierLimitField> &
  Partial<Pick<UserFeeTier, TierLimitField>>

export type BackendFeeTiers = Omit<FeeTiers, 'user_tiers'> & { user_tiers: BackendFeeTier[] }
