import { OrderTimeInForceEnum, type OrderTypeEnum } from 'zklighter-perps'

import type { OrderBookDetail } from '../types/compatibility'
import { getOrderAmountErrorType } from './getOrderAmountErrorType'

export const getTiedSLTPLimitPrice = (
  limitPrice: number,
  orderSize: number,
  market: OrderBookDetail,
  orderTypeEnum: OrderTypeEnum,
): number => {
  if (!limitPrice) return 0

  return getOrderAmountErrorType(
    orderSize,
    limitPrice,
    market,
    orderTypeEnum,
    OrderTimeInForceEnum.GoodTillTime,
  ) === 'minimum'
    ? 0
    : limitPrice
}
