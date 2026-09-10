import { API_KEY_INDEXES, useAccountsQuery, useLighterStore } from 'lighter-ts'
import { useEffect } from 'react'
import { readLSAccountSignature, readLSLastAccountIndex } from '../utils/auth-storage'

export const useAccount = () => {
  const accountsQuery = useAccountsQuery()

  useEffect(() => {
    if (accountsQuery.isPending) {
      return
    }

    if (accountsQuery.isError) {
      return useLighterStore.setState({
        accountIndex: 0,
        accountExistence: 'Deciding',
      })
    }

    const subAccountsByIndex = accountsQuery.data.accountsByIndex
    const lastAccountIndex = readLSLastAccountIndex().data

    const account =
      (lastAccountIndex ? subAccountsByIndex[lastAccountIndex] : undefined) ??
      accountsQuery.data.mainAccount

    const nextAccountIndex = account?.index ?? 0
    const hasStoredSignature =
      account != null && !!readLSAccountSignature(account.index, API_KEY_INDEXES.DESKTOP)

    useLighterStore.setState((prevState) => ({
      accountIndex: nextAccountIndex,
      accountTradingMode: account?.account_trading_mode ?? null,
      accountExistence:
        nextAccountIndex !== prevState.accountIndex ? 'Deciding' : prevState.accountExistence,
      showOnboarding: prevState.didJustConnect && !hasStoredSignature,
      didJustConnect: false,
    }))
  }, [accountsQuery.isPending, accountsQuery.isError, accountsQuery.data])
}
