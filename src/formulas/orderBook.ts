import { MAX_MARKET_ORDER_SLIPPAGE } from '../constants/shared'
import type { BOTimeInForce } from '../store/bo/createBOSlice'
import type { TimeInForce } from '../store/place-order/utils'
import type { OrderbookItem } from '../store/types'
import type { OrderBookDetail } from '../types/compatibility'
import { OrderType } from '../types/order'
import { floorNumber, roundNumber } from '../utils/precision'

export const computeWorstExecutionPrice = (
  maxSlippage: number,
  isShort: boolean,
  bestPrice: number,
) => bestPrice * (1 + (maxSlippage / 100) * (isShort ? -1 : 1))

// Bound perps TWAP buys at double the mark and sells at half; spot uses index slippage.
export const computeTWAPOrderPrice = (
  isShort: boolean,
  isSpot: boolean,
  markPrice: number | null,
  indexPrice: number | null,
) => {
  if (!isSpot) {
    return markPrice ? computeWorstExecutionPrice(isShort ? 50 : 100, isShort, markPrice) : 0
  }

  return indexPrice ? computeWorstExecutionPrice(MAX_MARKET_ORDER_SLIPPAGE, isShort, indexPrice) : 0
}

export const computeAvailableLiquidity = (
  orders: OrderbookItem[],
  market: Pick<OrderBookDetail, 'size_decimals'>,
) =>
  roundNumber(
    orders.reduce((total, order) => total + order.size, 0),
    market.size_decimals,
  )

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

export const computeNotEnoughMargin = (
  sliderMax: number,
  baseAmount: number,
  market: Pick<OrderBookDetail, 'size_decimals'>,
) => floorNumber(baseAmount - sliderMax, market.size_decimals) > 0

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

export const computeVeryHighSlippage = (orderType: OrderType, slippage: number) =>
  orderType === OrderType.Market && slippage > 5

export const computeShouldShowLimitPriceWarning = (
  orderType: OrderType,
  timeInForce: TimeInForce | BOTimeInForce,
  isShort: boolean,
  limitPrice: number,
  baseAmount: number,
  { bids, asks }: { bids: OrderbookItem[]; asks: OrderbookItem[] },
) => {
  if (
    orderType !== OrderType.Limit ||
    timeInForce === 'ioc' ||
    !baseAmount ||
    bids.length === 0 ||
    asks.length === 0
  ) {
    return false
  }

  return isShort ? limitPrice <= bids[0]!.price : limitPrice >= asks[0]!.price
}

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
// and derive the average price (estimated price) and how much that means in quote.
// Past the visible book the remainder is matched at the last price; estPrice only covers the visible fill
export const matchBaseAmount = (
  market: Pick<OrderBookDetail, 'price_decimals'>,
  baseAmount: number,
  orders: OrderbookItem[],
): MatchBaseResult => {
  let baseAmountLeft = baseAmount
  let matchedQuoteAmount = 0
  let filledBaseAmount = 0
  let filledQuoteAmount = 0

  for (const [index, order] of orders.entries()) {
    if (isZero(baseAmountLeft)) {
      break
    }

    const isLastOrder = index === orders.length - 1
    const matchedSize = isLastOrder ? baseAmountLeft : Math.min(baseAmountLeft, order.size)
    const filledSize = Math.min(matchedSize, order.size)

    matchedQuoteAmount = matchedQuoteAmount + matchedSize * order.price
    filledBaseAmount = filledBaseAmount + filledSize
    filledQuoteAmount = filledQuoteAmount + filledSize * order.price
    baseAmountLeft = baseAmountLeft - matchedSize
  }

  const quoteAmount = matchedQuoteAmount
    ? floorNumber(matchedQuoteAmount, market.price_decimals)
    : 0

  return {
    estPrice: filledBaseAmount ? filledQuoteAmount / filledBaseAmount : 0,
    quoteAmount,
  }
}

// runs the order book and tries to match a USD amount to orders
// and derive the average price (estimated price) and how much that means in token amount.
// Past the visible book the remainder is matched at the last price; estPrice only covers the visible fill
export const matchQuoteAmount = (
  market: Pick<OrderBookDetail, 'size_decimals'>,
  quoteAmount: number,
  orders: OrderbookItem[],
): MatchQuoteResult => {
  let quoteAmountLeft = quoteAmount
  let matchedBaseAmount = 0
  let filledBaseAmount = 0
  let filledQuoteAmount = 0

  for (const [index, order] of orders.entries()) {
    const isLastOrder = index === orders.length - 1
    const maxSizeForThisPrice = floorNumber(quoteAmountLeft / order.price, market.size_decimals)
    const matchedSize = isLastOrder
      ? maxSizeForThisPrice
      : Math.min(maxSizeForThisPrice, order.size)
    const filledSize = Math.min(matchedSize, order.size)

    matchedBaseAmount = matchedBaseAmount + matchedSize
    filledBaseAmount = filledBaseAmount + filledSize
    filledQuoteAmount = filledQuoteAmount + filledSize * order.price
    quoteAmountLeft = quoteAmountLeft - matchedSize * order.price

    if (matchedSize < order.size) {
      break
    }
  }

  const baseAmount = matchedBaseAmount ? roundNumber(matchedBaseAmount, market.size_decimals) : 0

  return {
    estPrice: filledBaseAmount ? filledQuoteAmount / filledBaseAmount : 0,
    baseAmount,
  }
}
