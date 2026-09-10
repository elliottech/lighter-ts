import type { StateCreator } from 'zustand'

import { type Account } from '../types'

export interface AccountsSlice {
  accounts: Record<number, Account>
  accountTradingMode: number | null
}

export const createAccountsSlice: StateCreator<AccountsSlice, [], [], AccountsSlice> = () => ({
  accounts: {},
  accountTradingMode: null,
})
