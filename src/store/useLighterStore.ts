import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { createUserSlice, type UserSlice } from './user/createUserSlice'
import { createOrderBookSlice, type OrderBookSlice } from './orderbook/createOrderBookSlice'
import { createAccountsSlice, type AccountsSlice } from './accounts/createAccountsSlice'
import { createAgentSlice, type AgentSlice } from './agent/createAgentSlice'
import { createPlaceOrderSlice, type PlaceOrderSlice } from './place-order/createPlaceOrderSlice'
import {
  createRepeatOrderPrefillSlice,
  type RepeatOrderPrefillSlice,
} from './repeat-order/createRepeateOrderPrefillSlice'
import { createPreferencesSlice, type PreferencesSlice } from './preferences/createPreferencesSlice'
import {
  createTableFiltersSlice,
  type TableFiltersSlice,
} from './table-filters/createTableFiltersSlice'
import { createTokensSlice, type TokensSlice } from './tokens/createTokensSlice'

export type LighterStore = UserSlice &
  OrderBookSlice &
  AccountsSlice &
  AgentSlice &
  PlaceOrderSlice &
  RepeatOrderPrefillSlice &
  PreferencesSlice &
  TableFiltersSlice &
  TokensSlice

export const useLighterStore = create<LighterStore>()(
  subscribeWithSelector((...args) => ({
    ...createAccountsSlice(...args),
    ...createAgentSlice(...args),
    ...createOrderBookSlice(...args),
    ...createUserSlice(...args),
    ...createPlaceOrderSlice(...args),
    ...createRepeatOrderPrefillSlice(...args),
    ...createPreferencesSlice(...args),
    ...createTableFiltersSlice(...args),
    ...createTokensSlice(...args),
  })),
)
export type LighterStoreWithSubscribe = typeof useLighterStore
