import { useMemo } from 'react'
import type { DetailedAccount } from '../store/types'
import { useLighterStore } from '../store/useLighterStore'
import { selectUserAccountIndex } from '../store/user/selectors'
import { usePublicAccountsEquity } from './usePublicAccountsEquity'
import { useAccountPublicPoolShares } from '../utils/public-pools'
import { selectPerpsEquity, selectSpotEquity } from '../store/selectors/common'
import { useUserAccount } from './useUserAccount'

type AccountEquity = {
  perpsEquity: number | null
  spotEquity: number | null
  stakingAmount: number | null
  stakingEquity: number | null
  poolEquity: number | null
  pendingUnstakedEquity: number | null
  totalEquity: number | null
}

const EMPTY_EQUITY: AccountEquity = {
  perpsEquity: null,
  spotEquity: null,
  stakingAmount: null,
  stakingEquity: null,
  poolEquity: null,
  pendingUnstakedEquity: null,
  totalEquity: null,
}

export const useAccountsEquity = (accounts: DetailedAccount[]) => {
  const userAccountIndex = useLighterStore(selectUserAccountIndex)
  const publicAccountsEquity = usePublicAccountsEquity(accounts)
  const { publicPoolEquity: userAccountPublicPoolEquity } = useAccountPublicPoolShares()
  const userPerpsEquity = useLighterStore(selectPerpsEquity)
  const userSpotEquity = useLighterStore(selectSpotEquity)

  return useMemo(() => {
    if (
      userAccountPublicPoolEquity === null ||
      userPerpsEquity === null ||
      userSpotEquity === null ||
      Object.keys(publicAccountsEquity).length === 0
    ) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(publicAccountsEquity).map(([accountIndex, equity]) => {
        const isSelected = Number(accountIndex) === userAccountIndex
        if (!isSelected) {
          return [Number(accountIndex), { ...equity, poolEquity: 0 }]
        }
        return [
          Number(accountIndex),
          {
            ...equity,
            perpsEquity: userPerpsEquity,
            spotEquity: userSpotEquity,
            poolEquity: userAccountPublicPoolEquity,
            totalEquity:
              userSpotEquity +
              userPerpsEquity +
              equity.stakingEquity +
              userAccountPublicPoolEquity +
              equity.pendingUnstakedEquity,
          },
        ]
      }),
    )
  }, [
    userAccountIndex,
    publicAccountsEquity,
    userAccountPublicPoolEquity,
    userPerpsEquity,
    userSpotEquity,
  ])
}

export const useAccountEquity = (accountArg?: DetailedAccount) => {
  const selectedAccount = useUserAccount()
  const account = accountArg ?? selectedAccount
  const accounts = useMemo(() => (account ? [account] : []), [account])
  const equity = useAccountsEquity(accounts)

  return account ? (equity[account.index] ?? EMPTY_EQUITY) : EMPTY_EQUITY
}
