import { keyBy } from 'lodash-es'
import { useMemo } from 'react'
import type { AccountApi, PublicPoolsMetadataRequest } from 'zklighter-perps'
import { SubAccountType, type PublicPoolMetadata, type Share } from '../store/types'
import { useAccountPublicPoolListQuery } from '../hooks/useAccountPublicPoolListQuery'
import { LIT_ASSET_ID, selectAssetIndexPrices } from '../store/orderbook/selectors'
import { useUserAccount } from '../hooks/useUserAccount'
import { useLighterStore } from '../store/useLighterStore'
import { useAccounts } from '../hooks/useAccountsQuery'
import { computeSpotEquity } from '../formulas/common'
import { MAX_ACCOUNT_INDEX_LIMIT } from '../constants/shared'
import { convertPublicPoolMetadata } from './restApiConversion'

export const getYourDeposits = (shares: Share[], publicPoolIndex: number) => {
  const share = shares.find((share) => share.public_pool_index === publicPoolIndex)

  if (!share) {
    return null
  }

  return share.principal_amount
}

const getYourReturns = (
  shares: Share[],
  publicPoolIndex: number,
  tvl: number,
  totalShares: number,
) => {
  const share = shares.find((share) => share.public_pool_index === publicPoolIndex)

  if (!share) {
    return null
  }

  return (share.shares_amount / totalShares) * tvl - share.principal_amount
}

export const getYourEquity = (
  shares: Share[],
  publicPoolIndex: number,
  tvl: number,
  totalShares: number,
) => {
  const share = shares.find((share) => share.public_pool_index === publicPoolIndex)

  if (!share) {
    return null
  }

  return (share.shares_amount / totalShares) * tvl
}

export const getYourPoolStats = (
  shares: Share[],
  publicPoolIndex: number,
  tvl: number,
  totalShares: number,
) => {
  const yourDeposits = getYourDeposits(shares, publicPoolIndex)
  const yourReturns = getYourReturns(shares, publicPoolIndex, tvl, totalShares)
  const yourEquity = getYourEquity(shares, publicPoolIndex, tvl, totalShares)

  return { yourDeposits, yourReturns, yourEquity }
}

export const useStakedAmount = () => {
  const stakingPoolsQuery = useAccountPublicPoolListQuery()

  return useMemo(() => {
    const stakingPools =
      stakingPoolsQuery.data?.pages
        .flatMap((page) => page.public_pools)
        .filter((pool) => pool.account_type === SubAccountType.Staking) ?? []

    return stakingPools.reduce(
      (totalEquity, stakingPool) =>
        totalEquity +
        (getYourEquity(
          stakingPool.account_share ? [stakingPool.account_share] : [],
          stakingPool.account_index,
          stakingPool.assets.find((asset) => asset.asset_id === LIT_ASSET_ID)?.balance ?? 0,
          stakingPool.total_shares,
        ) ?? 0),
      0,
    )
  }, [stakingPoolsQuery.data])
}

export const usePendingUnstakedAmount = () => {
  const userAccount = useUserAccount()

  const pendingUnstakes = useMemo(() => userAccount?.pending_unlocks ?? [], [userAccount])

  return useMemo(() => {
    return pendingUnstakes.reduce(
      (totalEquity, pendingUnstake) => totalEquity + pendingUnstake.amount,
      0,
    )
  }, [pendingUnstakes])
}

export const useStakingEquity = () => {
  const stakedAmount = useStakedAmount()
  const litIndexPrice = useLighterStore((state) => selectAssetIndexPrices(state)[LIT_ASSET_ID] ?? 0)

  return useMemo(() => {
    return stakedAmount * litIndexPrice
  }, [stakedAmount, litIndexPrice])
}

export const usePendingUnstakedEquity = () => {
  const pendingUnstakes = usePendingUnstakedAmount()
  const litIndexPrice = useLighterStore((state) => selectAssetIndexPrices(state)[LIT_ASSET_ID] ?? 0)

  return useMemo(() => {
    return pendingUnstakes * litIndexPrice
  }, [pendingUnstakes, litIndexPrice])
}

const EMPTY_INDEX_PRICES: Record<string, number> = {}

export const useAccountPublicPoolShares = () => {
  const userAccount = useUserAccount()
  const publicPoolsQuery = useAccountPublicPoolListQuery()
  const { publicPoolAccounts: userPublicPools } = useAccounts()
  // Index prices are only needed to value operator pools' spot holdings;
  // don't re-render every non-operator's portfolio on each price tick
  const hasOperatorPools = userPublicPools.length > 0
  const assetIndexPrices = useLighterStore((state) =>
    hasOperatorPools ? selectAssetIndexPrices(state) : EMPTY_INDEX_PRICES,
  )

  const { publicPoolDeposits, publicPoolReturns } = useMemo(() => {
    const publicPools = publicPoolsQuery.data?.pages
      .flatMap((page) => page.public_pools)
      .filter((pool) => {
        switch (pool.account_type) {
          case SubAccountType.LighterPublic:
          case SubAccountType.Public: {
            return true
          }
          default: {
            return false
          }
        }
      })

    // no data covers both pending and errored queries — equity is unknown, never zero
    if (!publicPools) {
      return { publicPoolDeposits: null, publicPoolReturns: null }
    }

    const deposits = publicPools.reduce(
      (totalDeposits, publicPool) =>
        totalDeposits +
        (getYourDeposits(
          publicPool.account_share ? [publicPool.account_share] : [],
          publicPool.account_index,
        ) ?? 0),
      0,
    )

    const returns = publicPools.reduce(
      (totalReturns, publicPool) =>
        totalReturns +
        (getYourReturns(
          publicPool.account_share ? [publicPool.account_share] : [],
          publicPool.account_index,
          // pool value = perps value (total_asset_value) + spot holdings value
          publicPool.total_asset_value + publicPool.total_spot_value,
          publicPool.total_shares,
        ) ?? 0),
      0,
    )

    if (userAccount?.account_type === SubAccountType.Main) {
      const userPublicPoolsReturns = userPublicPools.reduce(
        (total, pool) =>
          total +
          (getYourReturns(
            pool.pool_info?.operator_shares
              ? [
                  {
                    public_pool_index: pool.account_index,
                    shares_amount: pool.pool_info.operator_shares,
                    principal_amount: 0,
                    entry_timestamp: 0,
                  },
                ]
              : [],
            pool.account_index,
            // DetailedAccount has no total_spot_value; value the pool's spot
            // holdings from its asset balances at index prices
            pool.total_asset_value +
              (computeSpotEquity(assetIndexPrices, keyBy(pool.assets, 'asset_id')) ?? 0),
            pool.pool_info?.total_shares ?? 0,
          ) ?? 0),
        0,
      )

      return {
        publicPoolDeposits: deposits,
        publicPoolReturns: returns + userPublicPoolsReturns,
      }
    }

    return {
      publicPoolDeposits: deposits,
      publicPoolReturns: returns,
    }
  }, [publicPoolsQuery.data, userAccount, userPublicPools, assetIndexPrices])

  return {
    publicPoolDeposits,
    publicPoolReturns,
    publicPoolEquity:
      publicPoolDeposits === null || publicPoolReturns === null
        ? null
        : publicPoolDeposits + publicPoolReturns,
    isLoading: publicPoolsQuery.isPending,
    isError: publicPoolsQuery.isError,
  }
}

export const fetchAllPublicPools = async (
  accountApi: AccountApi,
  params: Omit<PublicPoolsMetadataRequest, 'index'>,
) => {
  const allPools: PublicPoolMetadata[] = []
  let currentIndex: number | undefined = MAX_ACCOUNT_INDEX_LIMIT

  while (currentIndex) {
    const result = await accountApi.publicPoolsMetadata({
      index: currentIndex,
      ...params,
    })
    const convertedPools = result.public_pools.map(convertPublicPoolMetadata)
    allPools.push(...convertedPools)
    currentIndex = convertedPools[convertedPools.length - 1]?.account_index
  }

  return allPools
}
