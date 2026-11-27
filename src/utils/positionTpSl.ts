import { OrderTriggerStatusEnum, OrderTypeEnum } from 'zklighter-perps'

import type { Order } from '../store/types'

const TP_SL_ORDER_TYPES: OrderTypeEnum[] = [
  OrderTypeEnum.TakeProfit,
  OrderTypeEnum.TakeProfitLimit,
  OrderTypeEnum.StopLoss,
  OrderTypeEnum.StopLossLimit,
]

export const isTpSlOrder = (order: Order) => TP_SL_ORDER_TYPES.includes(order.type)

export const isTakeProfitOrder = (order: Order) =>
  order.type === OrderTypeEnum.TakeProfit || order.type === OrderTypeEnum.TakeProfitLimit

export const isWholePositionTpSlOrder = (order: Order) =>
  isTpSlOrder(order) &&
  order.trigger_status === OrderTriggerStatusEnum.MarkPrice &&
  order.initial_base_amount === 0

export const isSizedTpSlOrder = (order: Order, isLong: boolean) =>
  isTpSlOrder(order) &&
  order.trigger_status !== OrderTriggerStatusEnum.ParentOrder &&
  order.is_ask === isLong &&
  !isWholePositionTpSlOrder(order)
