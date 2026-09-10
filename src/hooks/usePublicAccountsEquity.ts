import { keyBy } from 'lodash-es'
import { useMemo } from 'react'
import type { DetailedAccount, PublicPoolMetadata } from '../store/types'
import { getYourEquity } from '../utils/public-pools'
import { LIT_ASSET_ID, selectAssetIndexPrices } from '../store/orderbook/selectors'
import { useProtocolStakingPoolListQuery } from './useProtocolStakingPoolListQuery'
import { useLighterStore } from '../store/useLighterStore'
import { computeSpotEquity } from '../formulas/common'

type AccountEquity = {
  perpsEquity: number
  spotEquity: number
  stakingAmount: number
  stakingEquity: number
  pendingUnstakedEquity: number
  totalEquity: number
}

const computeAccountStakingParts = (account: DetailedAccount, stakingPools: PublicPoolMetadata[]) =>
  account.shares.reduce(
    (sum, share) => {
      const stakingPool = stakingPools.find(
        (stakingPool) => stakingPool.account_index === share.public_pool_index,
      )

      if (!stakingPool) {
        return sum
      }

      const shareArgs = [share]

      const stakedAmount =
        getYourEquity(
          shareArgs,
          stakingPool.account_index,
          stakingPool.assets.find((asset) => asset.asset_id === LIT_ASSET_ID)?.balance ?? 0,
          stakingPool.total_shares,
        ) ?? 0

      const stakedEquity =
        getYourEquity(
          shareArgs,
          stakingPool.account_index,
          stakingPool.total_spot_value,
          stakingPool.total_shares,
        ) ?? 0

      return {
        stakingAmount: sum.stakingAmount + stakedAmount,
        stakingEquity: sum.stakingEquity + stakedEquity,
      }
    },
    { stakingAmount: 0, stakingEquity: 0 },
  )

const computeAccountPendingUnstakedAmount = (account: DetailedAccount) =>
  (account.pending_unlocks ?? []).reduce((sum, pending) => sum + pending.amount, 0)

export const usePublicAccountsEquity = (accounts: DetailedAccount[]) => {
  const protocolStakingPoolListQuery = useProtocolStakingPoolListQuery()
  const assetIndexPrices = useLighterStore(selectAssetIndexPrices)
  const litIndexPrice = useLighterStore((state) => selectAssetIndexPrices(state)[LIT_ASSET_ID] ?? 0)

  const stakingPools = protocolStakingPoolListQuery.data?.public_pools

  return useMemo(() => {
    // no data covers both pending and errored queries — equity is unknown, never zero
    if (!stakingPools) {
      return {}
    }

    return accounts.reduce<Record<number, AccountEquity>>((acc, account) => {
      const perpsEquity = account.total_asset_value

      const spotEquity = computeSpotEquity(assetIndexPrices, keyBy(account.assets, 'asset_id')) ?? 0

      const { stakingAmount, stakingEquity } = computeAccountStakingParts(account, stakingPools)

      const pendingUnstakedEquity = computeAccountPendingUnstakedAmount(account) * litIndexPrice

      acc[account.index] = {
        perpsEquity,
        spotEquity,
        stakingAmount,
        stakingEquity,
        pendingUnstakedEquity,
        totalEquity: spotEquity + perpsEquity + stakingEquity + pendingUnstakedEquity,
      }

      return acc
    }, {})
  }, [accounts, stakingPools, litIndexPrice, assetIndexPrices])
}
