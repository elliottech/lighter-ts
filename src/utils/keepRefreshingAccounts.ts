import { type QueryClient } from '@tanstack/react-query'
import { type DetailedAccounts } from 'zklighter-perps'

import { computeAccountsQueryData } from '../hooks/useAccountsQuery'
import { apis } from '../lib/apis'
import { wait } from './common'

const REFRESH_INTERVAL = 10_000
const REFRESH_ATTEMPTS = 30

export const keepRefreshingAccounts = async (
  queryClient: QueryClient,
  userAddress: string,
  isUpdated: (accounts: DetailedAccounts) => boolean,
) => {
  for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt++) {
    await wait(REFRESH_INTERVAL)
    if (!queryClient.getQueryState(['account', userAddress])) {
      return
    }
    const accounts = await apis.accountApi
      .account({ by: 'l1_address', value: userAddress })
      .catch(() => undefined)
    if (accounts && isUpdated(accounts) && queryClient.getQueryState(['account', userAddress])) {
      queryClient.setQueryData(['account', userAddress], computeAccountsQueryData(accounts))
      queryClient.invalidateQueries({ queryKey: ['accountMetadata'] })
      queryClient.invalidateQueries({ queryKey: ['explorerAccount'] })
      return
    }
  }
}
