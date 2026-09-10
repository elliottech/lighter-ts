import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import type { DetailedAccounts, ResponseError } from 'zklighter-perps'
import { SubAccountType, type DetailedAccount } from '../store/types'
import { convertDetailedAccount } from '../utils/restApiConversion'
import { useUserAddress } from './useUserAddress'
import { apis } from '../lib/apis'
import { useLighterStore } from '../store/useLighterStore'
import { selectUserTier } from '../store/user/selectors'
import { getMaxSubAccountCount } from '../utils/getMaxSubAccountCount'

const POLL_INTERVAL_MS = 5 * 1000
const POLL_WINDOW_MS = 60 * 1000
const STALE_TIME_MS = 5 * 60 * 1000

export interface DetailedAccountWithFlags extends DetailedAccount {
  isMainAccount: boolean
  isSubAccount: boolean
  isPublicPoolAccount: boolean
}

export interface AccountsQueryData extends Omit<DetailedAccounts, 'accounts'> {
  accounts: DetailedAccount[]
  mainAccount?: DetailedAccountWithFlags
  subAccounts: DetailedAccountWithFlags[]
  publicPoolAccounts: DetailedAccountWithFlags[]
  accountsByIndex: Record<number, DetailedAccountWithFlags>
}

export const computeAccountsQueryData = (detailedAccounts: DetailedAccounts): AccountsQueryData => {
  let mainAccount: DetailedAccountWithFlags | undefined = undefined
  const accounts = detailedAccounts.accounts.map(convertDetailedAccount)
  const subAccounts: DetailedAccountWithFlags[] = []
  const publicPoolAccounts: DetailedAccountWithFlags[] = []
  const accountsByIndex: Record<number, DetailedAccountWithFlags> = {}
  for (const account of accounts) {
    const accountWithFlags: DetailedAccountWithFlags = {
      ...account,
      isMainAccount: account.account_type === SubAccountType.Main,
      isSubAccount: account.account_type !== SubAccountType.Main,
      isPublicPoolAccount:
        account.account_type === SubAccountType.Public ||
        account.account_type === SubAccountType.LighterPublic,
    }
    accountsByIndex[accountWithFlags.index] = accountWithFlags
    if (accountWithFlags.account_type === SubAccountType.Main) {
      mainAccount = accountWithFlags
    } else if (accountWithFlags.account_type === SubAccountType.Sub) {
      subAccounts.push(accountWithFlags)
    } else if (
      account.account_type === SubAccountType.Public ||
      account.account_type === SubAccountType.LighterPublic
    ) {
      publicPoolAccounts.push(accountWithFlags)
    }
  }
  return {
    ...detailedAccounts,
    accounts,
    mainAccount,
    subAccounts,
    publicPoolAccounts,
    accountsByIndex,
  }
}

export const useAccountsQuery = (
  options?: Omit<UseQueryOptions<AccountsQueryData, ResponseError>, 'queryKey' | 'queryFn'>,
) => {
  const userAddress = useUserAddress()

  return useQuery<AccountsQueryData, ResponseError>({
    queryKey: ['account', userAddress],
    queryFn: async () => {
      const accountsData = await apis.accountApi.account({ by: 'l1_address', value: userAddress })
      return computeAccountsQueryData(accountsData)
    },
    enabled: !!userAddress,
    refetchInterval: (query) => {
      // if the query is in error and the error is not 400 (not found), keep polling
      if (query.state.error && query.state.error.response?.status !== 400) {
        return POLL_INTERVAL_MS
      }

      const pendingUnlockTimesMs = (query.state.data?.accounts ?? [])
        .flatMap((account) => account.pending_unlocks ?? [])
        .map((unlock) => unlock.unlock_timestamp)

      if (pendingUnlockTimesMs.length === 0) {
        return undefined
      }

      const now = Date.now()
      const upcomingUnlockTimesMs = pendingUnlockTimesMs.filter(
        (unlockTimeMs) => unlockTimeMs > now,
      )

      // an unlock has passed but the backend hasn't cleared it yet -> poll until it's gone
      if (upcomingUnlockTimesMs.length === 0) {
        return POLL_INTERVAL_MS
      }

      const msUntilNextUnlock = Math.min(...upcomingUnlockTimesMs) - now

      // still more than a minute out -> don't poll, let the 5min staleTime cover it and
      // just wake up once when it enters the polling window
      if (msUntilNextUnlock > POLL_WINDOW_MS) {
        return msUntilNextUnlock - POLL_WINDOW_MS
      }

      // within the window -> poll, and refetch right when it passes so we reflect it immediately
      return Math.min(POLL_INTERVAL_MS, msUntilNextUnlock)
    },
    refetchOnMount: true,
    staleTime: STALE_TIME_MS,
    ...options,
  })
}

const EMPTY_ARRAY = [] as DetailedAccountWithFlags[]
const EMPTY_ACCOUNTS_BY_INDEX = {} as Record<number, DetailedAccountWithFlags>
export const useAccounts = (
  options?: Omit<UseQueryOptions<AccountsQueryData, ResponseError>, 'queryKey' | 'queryFn'>,
) => {
  const accountsQuery = useAccountsQuery(options)

  return {
    accountsQuery: accountsQuery,
    mainAccount: accountsQuery.data?.mainAccount,
    subAccounts: accountsQuery.data?.subAccounts ?? EMPTY_ARRAY,
    publicPoolAccounts: accountsQuery.data?.publicPoolAccounts ?? EMPTY_ARRAY,
    accountsByIndex: accountsQuery.data?.accountsByIndex ?? EMPTY_ACCOUNTS_BY_INDEX,
  }
}

export const useSubAccountUsage = () => {
  const { subAccounts, publicPoolAccounts } = useAccounts()
  const userTier = useLighterStore(selectUserTier)

  const used = subAccounts.length + publicPoolAccounts.length
  const max = getMaxSubAccountCount(userTier)

  return { used, max, atLimit: used >= max }
}
