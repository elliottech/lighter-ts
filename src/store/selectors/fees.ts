import type { OrderBookDetail } from '../../types/compatibility'
import type { ExtendedUserTier } from '../../types/user-tiers'
import { getFeePercentageFromTier } from '../../utils/common'
import { selectCurrentMarket } from '../orderbook/selectors'
import { selectFeeTicks, selectUserTierName } from '../user/selectors'
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
): FeePercentages => {
  const fees = getFeePercentageFromTier(userTier, feeTicks)

  return {
    makerFee: currentMarket.is_maker_fee_enabled ? fees.maker : 0,
    takerFee: currentMarket.is_taker_fee_enabled ? fees.taker : 0,
  }
}

export const selectCurrentMarketFees = createSelector(
  [selectUserTierName, selectFeeTicks, selectCurrentMarket],
  createTracking('selectCurrentMarketFees', computeCurrentMarketFees),
)
