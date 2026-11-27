import { useQueries } from '@tanstack/react-query'
import { keyBy, uniq } from 'lodash-es'
import { useMemo } from 'react'
import type { DetailedAccount, PublicPoolMetadata } from '../store/types'
import type { BOPositionPriceStats } from '../utils/bo'
import { getYourEquity } from '../utils/public-pools'
import {
  LIT_ASSET_ID,
  selectAssetIndexPrices,
  selectBOMarketsStats,
  selectSystemConfig,
} from '../store/orderbook/selectors'
import { useProtocolStakingPoolListQuery } from './useProtocolStakingPoolListQuery'
import { useLighterStore } from '../store/useLighterStore'
import { computeBOEquity, computeSpotEquity, hasSpotIndexPrices } from '../formulas/common'
import { apis } from '../lib/apis'
import { convertPublicPoolMetadata } from '../utils/restApiConversion'

const POOL_METADATA_REFRESH_INTERVAL_MS = 60_000

export type PublicAccountEquity = {
  perpsEquity: number
  spotEquity: number | null
  boEquity: number
  poolEquity: number | null
  stakingAmount: number | null
  stakingEquity: number | null
  pendingUnstakedAmount: number
  pendingUnstakedEquity: number | null
  totalEquity: number | null
  isPending: boolean
}

export type PoolMetadataResult = {
  pool: PublicPoolMetadata | null | undefined
  isPending: boolean
}

export const computeAccountStakingParts = (
  account: DetailedAccount,
  stakingPools: PublicPoolMetadata[],
) =>
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

export const computeAccountPendingUnstakedAmount = (account: DetailedAccount) =>
  (account.pending_unlocks ?? []).reduce((sum, pending) => sum + pending.amount, 0)

const computePendingUnstakedEquity = (amount: number, litIndexPrice: number | undefined) => {
  if (amount === 0) {
    return 0
  }

  return litIndexPrice === undefined ? null : amount * litIndexPrice
}

// The metadata list is ordered by account index descending below an exclusive
// upper bound, so a one-item page under the next index is the pool itself
const fetchPoolMetadata = async (poolIndex: number) => {
  const { public_pools } = await apis.accountApi.publicPoolsMetadata({
    index: poolIndex + 1,
    limit: 1,
    filter: 'all',
  })
  const pool = public_pools.find(({ account_index }) => account_index === poolIndex)

  return pool ? convertPublicPoolMetadata(pool) : null
}

const computeAccountPoolEquity = (
  account: DetailedAccount,
  poolsByIndex: Map<number, PoolMetadataResult>,
) =>
  account.shares.reduce<number | null>((sum, share) => {
    if (!poolsByIndex.has(share.public_pool_index)) {
      return sum
    }

    // undefined while the pool is loading or its request failed, null when it no longer exists
    const pool = poolsByIndex.get(share.public_pool_index)?.pool

    if (sum === null || pool === undefined) {
      return null
    }

    if (pool === null || pool.total_shares === 0) {
      return sum
    }

    // pool value = perps value (total_asset_value) + spot holdings value
    return (
      sum +
      (share.shares_amount / pool.total_shares) * (pool.total_asset_value + pool.total_spot_value)
    )
  }, 0)

const isAccountPoolEquityPending = (
  account: DetailedAccount,
  poolsByIndex: Map<number, PoolMetadataResult>,
) => account.shares.some((share) => poolsByIndex.get(share.public_pool_index)?.isPending)

export const computePublicAccountEquity = (
  account: DetailedAccount,
  stakingPools: PublicPoolMetadata[] | undefined,
  poolsByIndex: Map<number, PoolMetadataResult>,
  assetIndexPrices: Record<string, number>,
  boMarketsStats: Record<string, BOPositionPriceStats>,
): PublicAccountEquity => {
  // total_asset_value already counts open BO positions at cost (the backend's AccountBinaryOptionsValueUSD); boEquity
  // values them at their current price, so the cost comes out of the perps part to count each position once.
  const boCost = (account.bo_positions ?? []).reduce(
    (cost, position) => cost + Number(position.entry_quote),
    0,
  )
  const perpsEquity = account.total_asset_value - boCost

  const boEquity =
    computeBOEquity(boMarketsStats, keyBy(account.bo_positions ?? [], 'market_id')) ?? 0

  const spotEquity = hasSpotIndexPrices(assetIndexPrices, account.assets)
    ? (computeSpotEquity(assetIndexPrices, keyBy(account.assets, 'asset_id')) ?? 0)
    : null

  const poolEquity = computeAccountPoolEquity(account, poolsByIndex)

  const { stakingAmount, stakingEquity } = stakingPools
    ? computeAccountStakingParts(account, stakingPools)
    : { stakingAmount: null, stakingEquity: null }

  const pendingUnstakedAmount = computeAccountPendingUnstakedAmount(account)
  const pendingUnstakedEquity = computePendingUnstakedEquity(
    pendingUnstakedAmount,
    assetIndexPrices[LIT_ASSET_ID],
  )

  return {
    perpsEquity,
    spotEquity,
    boEquity,
    poolEquity,
    stakingAmount,
    stakingEquity,
    pendingUnstakedAmount,
    pendingUnstakedEquity,
    totalEquity:
      spotEquity === null ||
      poolEquity === null ||
      stakingEquity === null ||
      pendingUnstakedEquity === null
        ? null
        : perpsEquity + spotEquity + boEquity + poolEquity + stakingEquity + pendingUnstakedEquity,
    // index prices arrive over the websocket, so a missing one is still loading
    isPending:
      isAccountPoolEquityPending(account, poolsByIndex) ||
      spotEquity === null ||
      pendingUnstakedEquity === null,
  }
}

export const usePublicAccountsEquity = (accounts: DetailedAccount[]) => {
  const protocolStakingPoolListQuery = useProtocolStakingPoolListQuery()
  const assetIndexPrices = useLighterStore(selectAssetIndexPrices)
  const boMarketsStats = useLighterStore(selectBOMarketsStats)
  const stakingPoolIndex = useLighterStore((state) => selectSystemConfig(state).staking_pool_index)

  const stakingPools = protocolStakingPoolListQuery.data?.public_pools
  const isStakingPoolListPending = protocolStakingPoolListQuery.isPending

  const poolIndexes = useMemo(
    () =>
      uniq(
        accounts.flatMap((account) => account.shares.map((share) => share.public_pool_index)),
      ).filter((poolIndex) => poolIndex !== stakingPoolIndex),
    [accounts, stakingPoolIndex],
  )

  const poolResults = useQueries({
    queries: poolIndexes.map((poolIndex) => ({
      queryKey: ['accountPoolMetadata', poolIndex],
      queryFn: () => fetchPoolMetadata(poolIndex),
      staleTime: POOL_METADATA_REFRESH_INTERVAL_MS,
      refetchInterval: POOL_METADATA_REFRESH_INTERVAL_MS,
      retry: 1,
    })),
    combine: (results) =>
      results.map(({ data, isPending }): PoolMetadataResult => ({ pool: data, isPending })),
  })

  return useMemo(() => {
    if (isStakingPoolListPending) {
      return {}
    }

    // staking shares are valued from the staking pool list only, never as public pool shares
    const stakingPoolIndexes = new Set((stakingPools ?? []).map((pool) => pool.account_index))
    const poolsByIndex = new Map(
      poolIndexes
        .map(
          (poolIndex, index) =>
            [poolIndex, poolResults[index] ?? { pool: undefined, isPending: true }] as const,
        )
        .filter(([poolIndex]) => !stakingPoolIndexes.has(poolIndex)),
    )

    return accounts.reduce<Record<number, PublicAccountEquity>>((acc, account) => {
      acc[account.index] = computePublicAccountEquity(
        account,
        stakingPools,
        poolsByIndex,
        assetIndexPrices,
        boMarketsStats,
      )

      return acc
    }, {})
  }, [
    accounts,
    isStakingPoolListPending,
    stakingPools,
    poolIndexes,
    poolResults,
    assetIndexPrices,
    boMarketsStats,
  ])
}
