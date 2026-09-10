import type { OrderStatusEnum, OrderTriggerStatusEnum } from 'zklighter-perps/models/Order'
import type { Order } from '../store/types'
import type { OrderBookDetail } from './compatibility'

export interface OrderHistoryRow {
  type: string
  isLong: boolean
  sideDisplayText: string
  baseAmount: number
  quoteAmount: number
  filledBaseAmount: number
  filledQuoteAmount: number
  price: number | null
  average: number | null
  status: OrderStatusEnum
  time_in_force: string
  trigger_status: OrderTriggerStatusEnum
  order: Order
  market: OrderBookDetail
}
