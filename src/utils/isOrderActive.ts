import { OrderStatusEnum } from 'zklighter-perps'
import type { Order } from '../store/types'

export const isOrderActive = (order: Order) => {
  return (
    order.status === OrderStatusEnum.Open ||
    order.status === OrderStatusEnum.Pending ||
    order.status === OrderStatusEnum.InProgress
  )
}
