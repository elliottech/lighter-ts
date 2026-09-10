import type { OrderbookItem } from '../store/types'
import type { OrderBookDetail } from '../types/compatibility'
import { OrderType } from '../types/order'
import { floorNumber } from '../utils/precision'

export const computeWorstExecutionPrice = (
  maxSlippage: number,
  isShort: boolean,
  bestPrice: number,
) => bestPrice * (1 + (maxSlippage / 100) * (isShort ? -1 : 1))

export const computeAvailableLiquidity = (orders: OrderbookItem[]) =>
  orders.reduce((total, order) => total + order.size, 0)

export const computeAvailableQuoteLiquidity = (orders: OrderbookItem[]) =>
  orders.reduce((total, order) => total + order.size * order.price, 0)

export const computeBookFillFraction = (requestedAmount: number, availableAmount: number) =>
  requestedAmount > 0 ? Math.min(1, availableAmount / requestedAmount) : 0

export const computeNotEnoughLiquidity = (
  orderType: OrderType,
  orderBookLoading: boolean,
  availableLiquidity: number,
  baseAmount: number,
) => !orderBookLoading && orderType === OrderType.Market && availableLiquidity < baseAmount

export const computeMarketOrderPrice = (
  maxSlippage: number,
  isShort: boolean,
  orders: OrderbookItem[],
) => {
  if (!orders.length) {
    return 0
  }

  const bestPrice = orders[0]!.price
  const worstOrderAveragePrice = computeWorstExecutionPrice(maxSlippage, isShort, bestPrice)
  const worstTradePrice = computeWorstExecutionPrice(maxSlippage * 2, isShort, bestPrice)

  let baseAmount = 0
  let quoteAmount = 0
  for (const order of orders) {
    if (isShort ? order.price >= worstTradePrice : order.price <= worstTradePrice) {
      baseAmount += order.size
      quoteAmount += order.size * order.price
    } else {
      break
    }
  }

  return (isShort ? Math.max : Math.min)(worstOrderAveragePrice, quoteAmount / baseAmount)
}

export const computeSlippage = (estPrice: number, bestPrice: number) =>
  estPrice !== 0 && bestPrice !== 0 ? Math.abs((estPrice - bestPrice) / bestPrice) * 100 : 0

export const computeTooMuchSlippage = (
  orderType: OrderType,
  slippage: number,
  maxSlippage: number,
) => orderType === OrderType.Market && slippage > maxSlippage

const ALMOST_ZERO = 10 ** -12
const isZero = (value: number) => Math.abs(value) < ALMOST_ZERO

export type MatchInfo = {
  // estimated average execution price for the entire order -> used for other computations
  estPrice: number
  // base amount as a string, the value of the order size input when the token option is selected
  baseAmountInputValue: string
  // quote amount as a string, the value of the order size input when the quote option is selected
  quoteAmountInputValue: string
  // numerical values
  baseAmount: number
  quoteAmount: number
}

type MatchBaseResult = {
  estPrice: number
  quoteAmount: number
}

type MatchQuoteResult = {
  estPrice: number
  baseAmount: number
}

// runs the order book and tries to match a token amount to orders
// and derive the average price (estimated price) and how much that means in quote
export const matchBaseAmount = (
  market: Pick<OrderBookDetail, 'price_decimals'>,
  baseAmount: number,
  orders: OrderbookItem[],
): MatchBaseResult => {
  let baseAmountLeft = baseAmount
  let matchedBaseAmount = 0
  let matchedQuoteAmount = 0

  for (const order of orders) {
    if (isZero(baseAmountLeft)) {
      break
    }

    const matchedSize = Math.min(baseAmountLeft, order.size)

    matchedBaseAmount = matchedBaseAmount + matchedSize
    matchedQuoteAmount = matchedQuoteAmount + matchedSize * order.price
    baseAmountLeft = baseAmountLeft - matchedSize
  }

  const quoteAmount = matchedQuoteAmount
    ? floorNumber(matchedQuoteAmount, market.price_decimals)
    : 0

  return {
    estPrice: matchedBaseAmount ? matchedQuoteAmount / matchedBaseAmount : 0,
    quoteAmount,
  }
}

// runs the order book and tries to match a USD amount to orders
// and derive the average price (estimated price) and how much that means in token amount
export const matchQuoteAmount = (
  market: Pick<OrderBookDetail, 'size_decimals'>,
  quoteAmount: number,
  orders: OrderbookItem[],
): MatchQuoteResult => {
  let quoteAmountLeft = quoteAmount
  let matchedBaseAmount = 0
  let matchedQuoteAmount = 0

  for (const order of orders) {
    const matchedSize = Math.min(
      floorNumber(quoteAmountLeft / order.price, market.size_decimals),
      order.size,
    )

    matchedBaseAmount = matchedBaseAmount + matchedSize
    matchedQuoteAmount = matchedQuoteAmount + matchedSize * order.price
    quoteAmountLeft = quoteAmountLeft - matchedSize * order.price

    if (matchedSize < order.size) {
      break
    }
  }

  const baseAmount = matchedBaseAmount ? floorNumber(matchedBaseAmount, market.size_decimals) : 0

  return {
    estPrice: matchedBaseAmount ? matchedQuoteAmount / matchedBaseAmount : 0,
    baseAmount,
  }
}
