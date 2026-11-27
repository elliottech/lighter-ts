import type { OrderBookDetail } from '../types/compatibility'
import { formatMarketSize, formatQuoteAmount, getBaseSymbol } from './formatting'
import type { OrderAmountErrorType } from './getOrderAmountErrorType'

export const getOrderAmountErrorText = (
  errorType: OrderAmountErrorType,
  market: OrderBookDetail,
  isScale = false,
) => {
  if (errorType === 'maximum') {
    const maxAmount = formatQuoteAmount(market.order_quote_limit, market)

    if (isScale) {
      return {
        key: 'maximum_order_size_warning_scale',
        values: { maxValue: maxAmount },
      } as const
    }

    return {
      key: 'maximum_order_size_warning',
      values: { amount: maxAmount },
    } as const
  }

  const minBaseAmount = `${formatMarketSize(market.min_base_amount, market)} ${getBaseSymbol(market)}`
  const minQuoteAmount = formatQuoteAmount(market.min_quote_amount, market)

  if (isScale) {
    return {
      key: 'minimum_order_size_warning_scale',
      values: { minValue: minQuoteAmount, minSize: minBaseAmount },
    } as const
  }

  return {
    key: 'min_order_size_warning',
    values: { minValue: minQuoteAmount, minSize: minBaseAmount },
  } as const
}
