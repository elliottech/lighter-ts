import type { WsOrder } from '../lighter-ws/types/WsMessage'

export const getOrderAveragePrice = (
  order: Pick<WsOrder, 'filled_base_amount' | 'filled_quote_amount'>,
): number | null =>
  order.filled_base_amount ? order.filled_quote_amount / order.filled_base_amount : null
