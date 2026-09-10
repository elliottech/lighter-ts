import type { ExtendedUserTier } from '../types/user-tiers'

import { isRobinhoodEnv } from '../lib/env'

export type FeeRateType = 'maker' | 'taker'
export type SupportedTier = NonNullable<ExtendedUserTier>
type PremiumTier = Exclude<SupportedTier, 'standard' | 'plus'>
// Mirrors the BE UserTiers config (MakerFeeTicks / TakerFeeTicks / TWAPFeeTicks)
type LighterPlanFees = Record<FeeRateType | 'twap', number>

export type FeeTierConfig<Tier extends SupportedTier> = {
  key: Tier
  // Lighter tiers are earned by staked LIT, Robinhood tiers by trailing 14-day volume
  stakedLit: number
  minVolume?: number
  // sendTx / sendTxBatch calls per minute
  rateLimit: number
  discountPercent: string
  maker: number
  taker: number
  // Native TWAP orders pay max(twap, maker/taker)
  twap: number
  takerLatency: string
  latencyImprovement: string
}

// Standard runs on the backend defaults (no sendTx bucket or taker delay of its own)
export const LIGHTER_STANDARD_FEE_TIER: FeeTierConfig<'standard'> = {
  key: 'standard',
  stakedLit: 0,
  rateLimit: 4000,
  discountPercent: '-',
  maker: 0,
  taker: 0,
  twap: 0.0001,
  takerLatency: '300ms',
  latencyImprovement: '-',
}

export const LIGHTER_PLUS_FEE_TIER: FeeTierConfig<'plus'> = {
  key: 'plus',
  stakedLit: 0,
  rateLimit: 4000,
  discountPercent: '-',
  maker: 0.00005,
  taker: 0.00005,
  twap: 0,
  takerLatency: '300ms',
  latencyImprovement: '-',
}

// Canonical premium fee tier data shared by comparison logic and fee tier UI:
// https://apidocs.lighter.xyz/docs/account-types
export const LIGHTER_PREMIUM_FEE_TIERS: FeeTierConfig<PremiumTier>[] = [
  {
    key: 'premium',
    stakedLit: 0,
    rateLimit: 4000,
    discountPercent: '-',
    maker: 0.00004,
    taker: 0.00028,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_1',
    stakedLit: 1000,
    rateLimit: 5000,
    discountPercent: '2.5%',
    maker: 0.000039,
    taker: 0.000273,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_2',
    stakedLit: 3000,
    rateLimit: 6000,
    discountPercent: '5%',
    maker: 0.000038,
    taker: 0.000266,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_3',
    stakedLit: 10000,
    rateLimit: 7000,
    discountPercent: '10%',
    maker: 0.000036,
    taker: 0.000252,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_4',
    stakedLit: 30000,
    rateLimit: 8000,
    discountPercent: '15%',
    maker: 0.000034,
    taker: 0.000238,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_5',
    stakedLit: 100000,
    rateLimit: 12000,
    discountPercent: '20%',
    maker: 0.000032,
    taker: 0.000224,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_6',
    stakedLit: 300000,
    rateLimit: 24000,
    discountPercent: '25%',
    maker: 0.00003,
    taker: 0.00021,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_7',
    stakedLit: 500000,
    rateLimit: 48000,
    discountPercent: '30%',
    maker: 0.000028,
    taker: 0.000196,
    twap: 0,
    takerLatency: '140ms',
    latencyImprovement: '-',
  },
]

// Robinhood premium tiers are assigned by trailing 14-day volume, not staked
// LIT: https://apidocs.rh.lighter.xyz/docs/account-types
export const ROBINHOOD_PREMIUM_FEE_TIERS: FeeTierConfig<PremiumTier>[] = [
  {
    key: 'premium',
    stakedLit: 0,
    minVolume: 0,
    rateLimit: 4000,
    discountPercent: '-',
    maker: 0.00012,
    taker: 0.00035,
    twap: 0,
    takerLatency: '200ms',
    latencyImprovement: '-',
  },
  {
    key: 'premium_1',
    stakedLit: 0,
    minVolume: 1_000_000,
    rateLimit: 5000,
    discountPercent: '2.5%',
    maker: 0.000117,
    taker: 0.000341,
    twap: 0,
    takerLatency: '195ms',
    latencyImprovement: '2.5%',
  },
  {
    key: 'premium_2',
    stakedLit: 0,
    minVolume: 10_000_000,
    rateLimit: 6000,
    discountPercent: '5%',
    maker: 0.000114,
    taker: 0.000333,
    twap: 0,
    takerLatency: '190ms',
    latencyImprovement: '5%',
  },
  {
    key: 'premium_3',
    stakedLit: 0,
    minVolume: 20_000_000,
    rateLimit: 7000,
    discountPercent: '10%',
    maker: 0.000108,
    taker: 0.000315,
    twap: 0,
    takerLatency: '180ms',
    latencyImprovement: '10%',
  },
  {
    key: 'premium_4',
    stakedLit: 0,
    minVolume: 50_000_000,
    rateLimit: 8000,
    discountPercent: '15%',
    maker: 0.000102,
    taker: 0.000298,
    twap: 0,
    takerLatency: '170ms',
    latencyImprovement: '15%',
  },
  {
    key: 'premium_5',
    stakedLit: 0,
    minVolume: 200_000_000,
    rateLimit: 12000,
    discountPercent: '20%',
    maker: 0.000096,
    taker: 0.00028,
    twap: 0,
    takerLatency: '160ms',
    latencyImprovement: '20%',
  },
  {
    key: 'premium_6',
    stakedLit: 0,
    minVolume: 500_000_000,
    rateLimit: 24000,
    discountPercent: '30%',
    maker: 0.000084,
    taker: 0.000245,
    twap: 0,
    takerLatency: '150ms',
    latencyImprovement: '25%',
  },
]

export const ROBINHOOD_STANDARD_FEE_TIER: FeeTierConfig<'standard'> = {
  key: 'standard',
  stakedLit: 0,
  minVolume: 0,
  rateLimit: 4000,
  discountPercent: '-',
  maker: 0,
  taker: 0,
  twap: 0,
  takerLatency: '300ms',
  latencyImprovement: '-',
}

export const getPremiumFeeTiers = () =>
  isRobinhoodEnv() ? ROBINHOOD_PREMIUM_FEE_TIERS : LIGHTER_PREMIUM_FEE_TIERS

const toPlanFees = ({ maker, taker, twap }: FeeTierConfig<SupportedTier>): LighterPlanFees => ({
  maker,
  taker,
  twap,
})

const toPremiumPlanFees = (tiers: FeeTierConfig<PremiumTier>[]) =>
  tiers.reduce<Record<PremiumTier, LighterPlanFees>>(
    (feesByTier, tier) => {
      feesByTier[tier.key] = toPlanFees(tier)
      return feesByTier
    },
    {} as Record<PremiumTier, LighterPlanFees>,
  )

export const LIGHTER_PLAN_FEES: Record<SupportedTier, LighterPlanFees> = {
  standard: toPlanFees(LIGHTER_STANDARD_FEE_TIER),
  plus: toPlanFees(LIGHTER_PLUS_FEE_TIER),
  ...toPremiumPlanFees(LIGHTER_PREMIUM_FEE_TIERS),
}

const ROBINHOOD_TOP_TIER = ROBINHOOD_PREMIUM_FEE_TIERS[ROBINHOOD_PREMIUM_FEE_TIERS.length - 1]!

// Same shape as the Lighter table so every lookup only differs by env. Robinhood
// has no Plus tier and seven volume tiers; the unreachable keys mirror their
// nearest real tier rather than leaving holes in the record.
const ROBINHOOD_PLAN_FEES: Record<SupportedTier, LighterPlanFees> = {
  standard: toPlanFees(ROBINHOOD_STANDARD_FEE_TIER),
  plus: toPlanFees(ROBINHOOD_STANDARD_FEE_TIER),
  ...toPremiumPlanFees(ROBINHOOD_PREMIUM_FEE_TIERS),
  premium_7: toPlanFees(ROBINHOOD_TOP_TIER),
}

export const getPlanFees = (tier: ExtendedUserTier): LighterPlanFees =>
  (isRobinhoodEnv() ? ROBINHOOD_PLAN_FEES : LIGHTER_PLAN_FEES)[tier ?? 'standard']
