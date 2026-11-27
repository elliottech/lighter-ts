import { OrderTimeInForceEnum, OrderTypeEnum } from 'zklighter-perps'

import type { OrderBookDetail } from '../types/compatibility'

export type OrderAmountErrorType = 'maximum' | 'minimum'

export const getOrderAmountErrorType = (
  baseAmount: number,
  price: number,
  market: OrderBookDetail,
  orderTypeEnum: OrderTypeEnum,
  timeInForce: OrderTimeInForceEnum,
): OrderAmountErrorType | null => {
  const quoteAmount = baseAmount * price

  if (quoteAmount > Number(market.order_quote_limit)) {
    return 'maximum'
  }

  if (
    timeInForce === OrderTimeInForceEnum.ImmediateOrCancel ||
    orderTypeEnum === OrderTypeEnum.Market ||
    orderTypeEnum === OrderTypeEnum.StopLoss ||
    orderTypeEnum === OrderTypeEnum.TakeProfit ||
    orderTypeEnum === OrderTypeEnum.Twap ||
    ((orderTypeEnum === OrderTypeEnum.StopLossLimit ||
      orderTypeEnum === OrderTypeEnum.TakeProfitLimit) &&
      baseAmount === 0)
  ) {
    return null
  }

  if (
    baseAmount < Number(market.min_base_amount) ||
    quoteAmount < Number(market.min_quote_amount)
  ) {
    return 'minimum'
  }

  return null
}
