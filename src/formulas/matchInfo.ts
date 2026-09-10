import type { OrderbookItem } from '../store/types'
import type { OrderBookDetail } from '../types/compatibility'
import { OrderType, type OrderPlacementInput } from '../types/order'
import { displaySizeToReal, realSizeToDisplay } from '../utils/multiplier'
import { floorNumber } from '../utils/precision'

import { matchBaseAmount, matchQuoteAmount, type MatchInfo } from './orderBook'

export const computeSinglePriceMatchInfo = (
  pinnedInput: OrderPlacementInput,
  pinnedValueInputValue: string,
  sliderMax: number,
  price: number,
  market: Pick<
    OrderBookDetail,
    | 'price_decimals'
    | 'size_decimals'
    | 'multiplier'
    | 'display_size_decimals'
    | 'display_price_decimals'
  >,
): MatchInfo => {
  switch (pinnedInput) {
    case 'base': {
      const baseAmountInputValue = pinnedValueInputValue
      const baseAmount = displaySizeToReal(baseAmountInputValue, market)
      const quoteAmountInputValue =
        !baseAmount || !price
          ? ''
          : floorNumber(baseAmount * price, market.price_decimals).toString()
      const quoteAmount = Number(quoteAmountInputValue)

      return {
        estPrice: price,
        baseAmountInputValue,
        quoteAmountInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    case 'quote': {
      const quoteAmountInputValue = pinnedValueInputValue
      const quoteAmount = Number(quoteAmountInputValue)
      const baseAmountInputValue =
        !quoteAmount || !price ? '' : realSizeToDisplay(quoteAmount / price, market).toString()
      const baseAmount = displaySizeToReal(baseAmountInputValue, market)

      return {
        estPrice: price,
        baseAmountInputValue,
        quoteAmountInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    case 'percentage': {
      const percentage = Number(pinnedValueInputValue)
      if (!sliderMax || !percentage || !price) {
        return {
          estPrice: 0,
          baseAmountInputValue: '',
          quoteAmountInputValue: '',
          baseAmount: 0,
          quoteAmount: 0,
        }
      }

      const baseAmount = floorNumber((sliderMax * percentage) / 100, market.size_decimals)
      const baseAmountInputValue = realSizeToDisplay(baseAmount, market).toString()
      const quoteAmountInputValue = floorNumber(
        baseAmount * price,
        market.price_decimals,
      ).toString()
      const quoteAmount = Number(quoteAmountInputValue)

      return {
        estPrice: price,
        baseAmountInputValue,
        quoteAmountInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    default:
      return null as never
  }
}

export const computeMarketOrderMatchInfo = (
  market: Pick<
    OrderBookDetail,
    | 'price_decimals'
    | 'size_decimals'
    | 'multiplier'
    | 'display_size_decimals'
    | 'display_price_decimals'
  >,
  pinnedInput: OrderPlacementInput,
  pinnedValueInputValue: string,
  orderBookOrders: OrderbookItem[],
  sliderMax: number,
): MatchInfo => {
  switch (pinnedInput) {
    case 'base': {
      const baseAmountInputValue = pinnedValueInputValue
      const baseAmount = displaySizeToReal(pinnedValueInputValue, market)
      const { estPrice, quoteAmount } = matchBaseAmount(market, baseAmount, orderBookOrders)
      const quoteAmountInputValue = quoteAmount ? quoteAmount.toString() : ''

      return {
        estPrice,
        baseAmountInputValue,
        quoteAmountInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    case 'quote': {
      const quoteAmountInputValue = pinnedValueInputValue
      const quoteAmount = Number(pinnedValueInputValue)
      const { estPrice, baseAmount } = matchQuoteAmount(market, quoteAmount, orderBookOrders)
      const baseAmountInputValue = baseAmount
        ? realSizeToDisplay(baseAmount, market).toString()
        : ''

      return {
        estPrice,
        baseAmountInputValue,
        quoteAmountInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    case 'percentage': {
      const percentage = Number(pinnedValueInputValue)
      const baseAmount = floorNumber((sliderMax * percentage) / 100, market.size_decimals)
      const baseAmountInputValue = baseAmount
        ? realSizeToDisplay(baseAmount, market).toString()
        : ''
      const { estPrice, quoteAmount } = matchBaseAmount(market, baseAmount, orderBookOrders)
      const quoteAmountInputValue = quoteAmount ? quoteAmount.toString() : ''

      return {
        estPrice,
        baseAmountInputValue,
        quoteAmountInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    default:
      return null as never
  }
}

export const computeMatchInfo = (
  orderType: OrderType,
  pinnedInput: OrderPlacementInput,
  pinnedValueInputValue: string,
  limitPrice: number,
  midPrice: number,
  orderBookOrders: OrderbookItem[],
  market: Pick<
    OrderBookDetail,
    | 'price_decimals'
    | 'size_decimals'
    | 'multiplier'
    | 'display_size_decimals'
    | 'display_price_decimals'
  >,
  scaleAverageLimitPrice: number,
  sliderMax: number,
  fallbackPrice = 0,
  availableLiquidity = 0,
) => {
  switch (orderType) {
    case OrderType.Market: {
      if (availableLiquidity === 0) {
        return computeSinglePriceMatchInfo(
          pinnedInput,
          pinnedValueInputValue,
          sliderMax,
          fallbackPrice,
          market,
        )
      }

      return computeMarketOrderMatchInfo(
        market,
        pinnedInput,
        pinnedValueInputValue,
        orderBookOrders,
        sliderMax,
      )
    }
    case OrderType.Limit: {
      return computeSinglePriceMatchInfo(
        pinnedInput,
        pinnedValueInputValue,
        sliderMax,
        limitPrice,
        market,
      )
    }
    case OrderType.Conditional: {
      return computeSinglePriceMatchInfo(
        pinnedInput,
        pinnedValueInputValue,
        sliderMax,
        limitPrice || midPrice,
        market,
      )
    }
    case OrderType.Twap: {
      return computeSinglePriceMatchInfo(
        pinnedInput,
        pinnedValueInputValue,
        sliderMax,
        midPrice,
        market,
      )
    }
    case OrderType.Scale: {
      return computeSinglePriceMatchInfo(
        pinnedInput,
        pinnedValueInputValue,
        sliderMax,
        scaleAverageLimitPrice,
        market,
      )
    }
    default:
      return null as never
  }
}
