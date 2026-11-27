import { useMemo } from 'react'
import {
  AccountAccountTypeEnum,
  type AccountApi,
  type PublicPoolsMetadataRequest,
} from 'zklighter-perps'
import { type PublicPoolMetadata, type Share } from '../store/types'
import { useAccountPublicPoolListQuery } from '../hooks/useAccountPublicPoolListQuery'
import { LIT_ASSET_ID, selectAssetIndexPrices } from '../store/orderbook/selectors'
import { useUserAccount } from '../hooks/useUserAccount'
import { useLighterStore } from '../store/useLighterStore'
import { MAX_ACCOUNT_INDEX_LIMIT } from '../constants/shared'
import { convertPublicPoolMetadata } from './restApiConversion'

export const getYourDeposits = (shares: Share[], publicPoolIndex: number) => {
  const share = shares.find((share) => share.public_pool_index === publicPoolIndex)

  if (!share) {
    return null
  }

  return share.principal_amount
}

export const getRemainingLlpDepositLimit = (
  maxLlpAmount: string | undefined,
  shares: Share[],
  publicPoolIndex: number,
) => {
  if (maxLlpAmount === undefined) {
    return null
  }

  return Math.max(0, Number(maxLlpAmount) - (getYourDeposits(shares, publicPoolIndex) ?? 0))
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

export const getYourPublicPoolStats = (
  shares: Share[],
  publicPoolIndex: number,
  tvl: number | null,
  totalShares: number,
  operatorShares?: number,
) => {
  const yourDeposits = getYourDeposits(shares, publicPoolIndex)
  const poolStats = getYourPoolStats(
    [
      ...shares,
      ...(operatorShares
        ? [
            {
              public_pool_index: publicPoolIndex,
              shares_amount: operatorShares,
              principal_amount: 0,
              entry_timestamp: 0,
            },
          ]
        : []),
    ],
    publicPoolIndex,
    tvl ?? 0,
    totalShares,
  )
  const yourEquity = tvl === null ? null : poolStats.yourEquity
  const yourReturns = tvl === null ? null : poolStats.yourReturns

  return { yourDeposits, yourReturns, yourEquity }
}

export const useStakedAmount = () => {
  const stakingPoolsQuery = useAccountPublicPoolListQuery()

  return useMemo(() => {
    const stakingPools =
      stakingPoolsQuery.data?.pages
        .flatMap((page) => page.public_pools)
        .filter((pool) => pool.account_type === AccountAccountTypeEnum.LighterStakingPool) ?? []

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
