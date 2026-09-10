import type {
  OrderTypeEnum,
  TradesRoleEnum,
  TradeTypeEnum,
  TradesMarketTypeEnum,
} from 'zklighter-perps'
import type { TransferHistoryTypeEnum } from 'zklighter-perps/apis/TransactionApi'
import type { StateCreator } from 'zustand'
import type { OrderSide } from '../../constants/shared'

export interface TableFiltersSlice {
  tableFilters: {
    marketId: number | undefined
    side: OrderSide
    orderType: OrderTypeEnum | 'all'
    tradeType: TradeTypeEnum | 'all'
    role: TradesRoleEnum
    aggregateByOrder: boolean
    transferHistoryType: TransferHistoryTypeEnum | 'all'
    marketType: TradesMarketTypeEnum
  }
}

export const DEFAULT_TABLE_FILTERS = {
  marketId: undefined,
  side: 'all',
  orderType: 'all',
  tradeType: 'all',
  role: 'all',
  aggregateByOrder: false,
  transferHistoryType: 'all',
  marketType: 'all',
} as const

export const createTableFiltersSlice: StateCreator<
  TableFiltersSlice,
  [],
  [],
  TableFiltersSlice
> = () => ({ tableFilters: DEFAULT_TABLE_FILTERS })
