import { defaultLighterFeeTiers, defaultRobinhoodFeeTiers } from '../fallbacks/defaults'
import { isRobinhoodFeeTiers } from '../lib/env'
import { formatPercentage } from './formatting'
import { getMaxSubAccountCount } from './getMaxSubAccountCount'
import type { BackendFeeTier, BackendFeeTiers, ExtendedUserTier } from '../types/user-tiers'

export type FeeRateType = 'maker' | 'taker'
export type SupportedTier = NonNullable<ExtendedUserTier>
export type PremiumTier = Exclude<SupportedTier, 'standard' | 'plus'>
type PlanFees = Record<FeeRateType | 'twap', number>

export type FeeTierConfig<Tier extends SupportedTier> = {
  key: Tier
  // Lighter tiers are earned by staked LIT, Robinhood tiers by trailing 14-day volume
  stakedLit: number
  minVolume: number
  // sendTx / sendTxBatch calls per minute
  rateLimit: number
  discountPercent: string
  maker: number
  taker: number
  // Native TWAP orders pay max(twap, maker/taker)
  twap: number
  takerLatency: string
  latencyImprovement: string
  maxSubAccounts: number
}

export type FeeTierConfigs = {
  standard: FeeTierConfig<'standard'>
  plus: FeeTierConfig<'plus'>
  premium: FeeTierConfig<PremiumTier>[]
}

const FEE_TICK = 1_000_000
export const getFeePercentage = (fee: number) => fee / FEE_TICK

type TierLimits = Pick<
  FeeTierConfig<SupportedTier>,
  'rateLimit' | 'twap' | 'takerLatency' | 'latencyImprovement'
>

const limits = (
  rateLimit: number,
  takerLatency: string,
  latencyImprovement = '-',
  twap = 0,
): TierLimits => ({ rateLimit, twap, takerLatency, latencyImprovement })

const LIGHTER_TIER_LIMITS: Record<SupportedTier, TierLimits> = {
  standard: limits(40, '300ms', '-', 0.0001),
  plus: limits(4000, '300ms'),
  premium: limits(4000, '140ms'),
  premium_1: limits(5000, '140ms'),
  premium_2: limits(6000, '140ms'),
  premium_3: limits(7000, '140ms'),
  premium_4: limits(8000, '140ms'),
  premium_5: limits(12000, '140ms'),
  premium_6: limits(24000, '140ms'),
  premium_7: limits(72000, '140ms'),
}

const ROBINHOOD_TIER_LIMITS: Record<SupportedTier, TierLimits> = {
  standard: limits(40, '300ms', '-', 0.0001),
  plus: limits(8000, '300ms'),
  premium: limits(4000, '200ms'),
  premium_1: limits(5000, '195ms', '2.5%'),
  premium_2: limits(6000, '190ms', '5%'),
  premium_3: limits(7000, '180ms', '10%'),
  premium_4: limits(8000, '170ms', '15%'),
  premium_5: limits(12000, '160ms', '20%'),
  premium_6: limits(24000, '150ms', '25%'),
  premium_7: limits(48000, '150ms', '25%'),
}

const isSupportedTier = (name: string): name is SupportedTier => name in LIGHTER_TIER_LIMITS

const formatDiscount = (fee: number, baseFee: number) => {
  const discount = baseFee > 0 ? 1 - fee / baseFee : 0
  return discount > 0
    ? formatPercentage(discount, { maximumFractionDigits: 2, roundingMode: 'halfExpand' })
    : '-'
}

const getLatencyImprovement = (
  tier: BackendFeeTier,
  fallback: TierLimits,
  base?: BackendFeeTier,
) => {
  if (tier.taker_latency_ms === undefined) return fallback.latencyImprovement
  if (!base?.taker_latency_ms) return '-'
  const improvement = 1 - tier.taker_latency_ms / base.taker_latency_ms
  return improvement > 0
    ? formatPercentage(improvement, { maximumFractionDigits: 2, roundingMode: 'halfExpand' })
    : '-'
}

const toTierLimits = (
  tier: BackendFeeTier,
  fallback: TierLimits,
  base?: BackendFeeTier,
): TierLimits => ({
  rateLimit: tier.send_tx_rate_limit || fallback.rateLimit,
  twap: tier.twap_fee_ticks === undefined ? fallback.twap : getFeePercentage(tier.twap_fee_ticks),
  takerLatency:
    tier.taker_latency_ms === undefined ? fallback.takerLatency : `${tier.taker_latency_ms}ms`,
  latencyImprovement: getLatencyImprovement(tier, fallback, base),
})

const toFeeTierConfig = <Tier extends SupportedTier>(
  tier: BackendFeeTier & { name: Tier },
  tierLimits: Record<SupportedTier, TierLimits>,
  base?: BackendFeeTier,
): FeeTierConfig<Tier> => ({
  key: tier.name,
  stakedLit: tier.required_lit_stakes,
  minVolume: tier.required_volume,
  discountPercent: base ? formatDiscount(tier.maker_fee_ticks, base.maker_fee_ticks) : '-',
  maker: getFeePercentage(tier.maker_fee_ticks),
  taker: getFeePercentage(tier.taker_fee_ticks),
  ...toTierLimits(tier, tierLimits[tier.name], base),
  maxSubAccounts: tier.max_sub_accounts || getMaxSubAccountCount(tier.name),
})

const getDefaultFeeTiers = (): BackendFeeTiers =>
  isRobinhoodFeeTiers() ? defaultRobinhoodFeeTiers : defaultLighterFeeTiers

const buildFeeTierConfigs = (feeTiers: BackendFeeTiers): FeeTierConfigs | null => {
  const tierLimits = isRobinhoodFeeTiers() ? ROBINHOOD_TIER_LIMITS : LIGHTER_TIER_LIMITS
  const tiers = feeTiers.user_tiers.filter(
    (tier): tier is BackendFeeTier & { name: SupportedTier } => isSupportedTier(tier.name),
  )
  const standard = tiers.find(
    (tier): tier is BackendFeeTier & { name: 'standard' } => tier.name === 'standard',
  )
  const plus = tiers.find((tier): tier is BackendFeeTier & { name: 'plus' } => tier.name === 'plus')
  const premium = tiers
    .filter((tier): tier is BackendFeeTier & { name: PremiumTier } =>
      tier.name.startsWith('premium'),
    )
    .sort(
      (a, b) =>
        a.required_lit_stakes + a.required_volume - (b.required_lit_stakes + b.required_volume),
    )
  const basePremium = premium[0]

  if (!standard || !plus || !basePremium) {
    return null
  }

  return {
    standard: toFeeTierConfig(standard, tierLimits),
    plus: toFeeTierConfig(plus, tierLimits),
    premium: premium.map((tier) => toFeeTierConfig(tier, tierLimits, basePremium)),
  }
}

export const resolveFeeTiers = (
  feeTiers: BackendFeeTiers | null,
  fallbackFeeTiers: BackendFeeTiers | null = null,
): BackendFeeTiers => feeTiers ?? fallbackFeeTiers ?? getDefaultFeeTiers()

// The default tiers always hold all three plans (see fees.test.ts)
export const toFeeTierConfigs = (
  feeTiers: BackendFeeTiers,
  fallbackFeeTiers: BackendFeeTiers | null = null,
): FeeTierConfigs =>
  buildFeeTierConfigs(feeTiers) ??
  buildFeeTierConfigs(resolveFeeTiers(null, fallbackFeeTiers)) ??
  buildFeeTierConfigs(getDefaultFeeTiers())!

const toPlanFees = ({ maker, taker, twap }: FeeTierConfig<SupportedTier>): PlanFees => ({
  maker,
  taker,
  twap,
})

// A tier the backend does not list (Robinhood has no premium_7) pays the top premium rate
export const getPlanFees = (configs: FeeTierConfigs, tier: ExtendedUserTier): PlanFees => {
  if (!tier || tier === 'standard') return toPlanFees(configs.standard)
  if (tier === 'plus') return toPlanFees(configs.plus)
  const premium =
    configs.premium.find(({ key }) => key === tier) ?? configs.premium[configs.premium.length - 1]!
  return toPlanFees(premium)
}

// Get fee percentages from AccountLimits if available, otherwise fall back to tier-based calculation
export const getFeePercentageFromTier = (
  tier: ExtendedUserTier,
  feeTicks: { takerFeeTick: number; makerFeeTick: number } | null,
  feeTierConfigs: FeeTierConfigs,
) => {
  // If fee ticks are provided, use them (for premium accounts with backend-provided fees)
  if (feeTicks) {
    return {
      taker: getFeePercentage(feeTicks.takerFeeTick),
      maker: getFeePercentage(feeTicks.makerFeeTick),
    }
  }

  return getPlanFees(feeTierConfigs, tier)
}
