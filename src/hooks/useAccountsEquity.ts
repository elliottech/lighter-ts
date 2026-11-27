import { keyBy, mapValues } from 'lodash-es'
import { useMemo } from 'react'
import type { DetailedAccount } from '../store/types'
import { useLighterStore } from '../store/useLighterStore'
import { selectUserAccountIndex } from '../store/user/selectors'
import { type PublicAccountEquity, usePublicAccountsEquity } from './usePublicAccountsEquity'
import { selectBOEquity, selectPerpsEquity, selectSpotEquity } from '../store/selectors/common'
import { selectAssetIndexPrices } from '../store/orderbook/selectors'
import { computeSpotEquity, hasSpotIndexPrices } from '../formulas/common'
import { useUserAccount } from './useUserAccount'
import { useAccounts } from './useAccountsQuery'

type AccountEquity = {
  perpsEquity: number | null
  spotEquity: number | null
  boEquity: number | null
  stakingAmount: number | null
  stakingEquity: number | null
  poolEquity: number | null
  pendingUnstakedAmount: number | null
  pendingUnstakedEquity: number | null
  totalEquity: number | null
  isPending: boolean
}

const EMPTY_EQUITY: AccountEquity = {
  perpsEquity: null,
  spotEquity: null,
  boEquity: null,
  stakingAmount: null,
  stakingEquity: null,
  poolEquity: null,
  pendingUnstakedAmount: null,
  pendingUnstakedEquity: null,
  totalEquity: null,
  isPending: true,
}

export const useAccountsEquity = (accounts: DetailedAccount[]) => {
  const userAccountIndex = useLighterStore(selectUserAccountIndex)
  const publicAccountsEquity = usePublicAccountsEquity(accounts)
  const userPerpsEquity = useLighterStore(selectPerpsEquity)
  const userSpotEquity = useLighterStore(selectSpotEquity)
  const userBOEquity = useLighterStore(selectBOEquity)

  return useMemo(() => {
    if (
      userPerpsEquity === null ||
      userSpotEquity === null ||
      userBOEquity === null ||
      Object.keys(publicAccountsEquity).length === 0
    ) {
      return {}
    }

    return mapValues(publicAccountsEquity, (equity, accountIndex): PublicAccountEquity => {
      if (Number(accountIndex) !== userAccountIndex) {
        return equity
      }
      return {
        ...equity,
        perpsEquity: userPerpsEquity,
        spotEquity: userSpotEquity,
        boEquity: userBOEquity,
        totalEquity:
          equity.poolEquity === null ||
          equity.stakingEquity === null ||
          equity.pendingUnstakedEquity === null
            ? null
            : userPerpsEquity +
              userSpotEquity +
              userBOEquity +
              equity.poolEquity +
              equity.stakingEquity +
              equity.pendingUnstakedEquity,
      }
    })
  }, [userAccountIndex, publicAccountsEquity, userPerpsEquity, userSpotEquity, userBOEquity])
}

export const computeOperatorPoolsEquity = (
  poolAccounts: DetailedAccount[],
  assetIndexPrices: Record<string, number>,
) =>
  poolAccounts.reduce<number | null>((sum, pool) => {
    if (sum === null || !pool.pool_info?.operator_shares) {
      return sum
    }

    if (!hasSpotIndexPrices(assetIndexPrices, pool.assets)) {
      return null
    }

    // DetailedAccount has no total_spot_value; value the pool's spot
    // holdings from its asset balances at index prices
    const poolValue =
      pool.total_asset_value +
      (computeSpotEquity(assetIndexPrices, keyBy(pool.assets, 'asset_id')) ?? 0)

    return sum + (pool.pool_info.operator_shares / pool.pool_info.total_shares) * poolValue
  }, 0)

// Account lists show the user's pool accounts as their own rows, so only the
// single-account equity adds the main account's operator share of its pools
export const useAccountEquity = (accountArg?: DetailedAccount) => {
  const selectedAccount = useUserAccount()
  const account = accountArg ?? selectedAccount
  const accounts = useMemo(() => (account ? [account] : []), [account])
  const equity = useAccountsEquity(accounts)
  const { mainAccount, publicPoolAccounts } = useAccounts()
  const assetIndexPrices = useLighterStore(selectAssetIndexPrices)

  const accountEquity = account ? equity[account.index] : undefined
  const isUserMainAccount = !!account && account.index === mainAccount?.index

  return useMemo(() => {
    if (!accountEquity) {
      return EMPTY_EQUITY
    }

    const operatorPoolsEquity = isUserMainAccount
      ? computeOperatorPoolsEquity(publicPoolAccounts, assetIndexPrices)
      : 0

    if (operatorPoolsEquity === 0) {
      return accountEquity
    }

    return {
      ...accountEquity,
      poolEquity:
        accountEquity.poolEquity === null || operatorPoolsEquity === null
          ? null
          : accountEquity.poolEquity + operatorPoolsEquity,
      totalEquity:
        accountEquity.totalEquity === null || operatorPoolsEquity === null
          ? null
          : accountEquity.totalEquity + operatorPoolsEquity,
      isPending: accountEquity.isPending || operatorPoolsEquity === null,
    }
  }, [accountEquity, isUserMainAccount, publicPoolAccounts, assetIndexPrices])
}
