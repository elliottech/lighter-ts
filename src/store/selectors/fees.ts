import type { StakingFeeTier } from 'zklighter-perps'

import type { OrderBookDetail } from '../../types/compatibility'
import type { ExtendedUserTier } from '../../types/user-tiers'
import { type FeeTierConfigs, getFeePercentageFromTier } from '../../utils/fees'
import { selectCurrentMarket, selectFeeTierConfigs, selectFeeTiers } from '../orderbook/selectors'
import {
  selectBOAccountFeeRate,
  selectBOUserTierName,
  selectFeeTicks,
  selectUserTierName,
} from '../user/selectors'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

export type FeePercentages = {
  makerFee: number
  takerFee: number
}

type FeeTicks = {
  makerFeeTick: number
  takerFeeTick: number
} | null

const computeCurrentMarketFees = (
  userTier: ExtendedUserTier,
  feeTicks: FeeTicks,
  currentMarket: Pick<OrderBookDetail, 'is_maker_fee_enabled' | 'is_taker_fee_enabled'>,
  feeTierConfigs: FeeTierConfigs,
): FeePercentages => {
  const fees = getFeePercentageFromTier(userTier, feeTicks, feeTierConfigs)

  return {
    makerFee: currentMarket.is_maker_fee_enabled ? fees.maker : 0,
    takerFee: currentMarket.is_taker_fee_enabled ? fees.taker : 0,
  }
}

export const selectCurrentMarketFees = createSelector(
  [selectUserTierName, selectFeeTicks, selectCurrentMarket, selectFeeTierConfigs],
  createTracking('selectCurrentMarketFees', computeCurrentMarketFees),
)

type BOStakingFeeTier = Pick<StakingFeeTier, 'required_lit_stakes' | 'fee_rate'>

const BO_NO_STAKING_TIER: BOStakingFeeTier = { required_lit_stakes: 0, fee_rate: 1 }

const findClosestIndex = (rates: number[], target: number) =>
  rates.reduce(
    (best, rate, index) =>
      Math.abs(rate - target) < Math.abs(rates[best]! - target) ? index : best,
    0,
  )

// The account's rate is volume tier × staking tier, so the staking tier is recovered from the quotient
export const selectBOFeeSchedule = createSelector(
  [selectFeeTiers, selectBOUserTierName, selectBOAccountFeeRate],
  createTracking('selectBOFeeSchedule', (feeTiers, boUserTierName, accountFeeRate) => {
    const volumeTiers = feeTiers.bo_tiers
    const stakingTiers = [BO_NO_STAKING_TIER, ...feeTiers.staking_tiers]
    const namedVolumeTierIndex = volumeTiers.findIndex(({ name }) => name === boUserTierName)
    const volumeTierIndex = namedVolumeTierIndex === -1 ? 0 : namedVolumeTierIndex
    const volumeTierRate = volumeTiers[volumeTierIndex]?.fee_rate ?? 1
    const stakingTierIndex =
      volumeTierRate > 0
        ? findClosestIndex(
            stakingTiers.map(({ fee_rate }) => fee_rate),
            accountFeeRate / volumeTierRate,
          )
        : 0

    return { volumeTiers, stakingTiers, volumeTierIndex, stakingTierIndex }
  }),
)
