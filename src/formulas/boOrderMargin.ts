import { partition } from 'lodash-es'
import { AccountBinaryOptionsPositionSignEnum, type EventOrderBookEntry } from 'zklighter-perps'

import { matchBaseAmount, matchQuoteAmount, type MatchInfo } from './orderBook'
import { doesOrderUseMargin } from './orderMargin'
import type { AssetBalance, BOPosition, Order, OrderbookItem } from '../store/types'
import { USDC_ASSET_ID } from '../store/orderbook/selectors'
import { OrderType, type OrderPlacementInput } from '../types/order'
import type { BOSide, BOTimeInForce } from '../store/bo/createBOSlice'
import type { OrderAmountErrorType } from '../utils/getOrderAmountErrorType'

import { floorNumber, floorPercentOf } from '../utils/precision'
import { formatBOSize, formatUSD } from '../utils/formatting'
import {
  BO_PRICE_DECIMALS,
  BO_SETTLEMENT_VALUE,
  BO_SIZE_DECIMALS,
  clampBOPrice,
  flipBOPrice,
} from '../utils/bo'

const computeBOBuySellSide = (activeOrders: Order[], isPositionShort: boolean) => {
  const [sellOrders, buyOrders] = partition(
    activeOrders.filter(doesOrderUseMargin),
    (order) => order.is_ask,
  )
  const buyValue = buyOrders.reduce(
    (acc, order) => acc + order.remaining_base_amount * order.price,
    0,
  )
  const sellValue = sellOrders.reduce(
    (acc, order) => acc + order.remaining_base_amount * flipBOPrice(order.price),
    0,
  )

  return {
    sameSideOrderValue: isPositionShort ? sellValue : buyValue,
    oppositeSideOrderValue: isPositionShort ? buyValue : sellValue,
  }
}

const getBOOrderValuesForMarket = (activeOrders: Order[], position?: BOPosition) => {
  const isPositionShort = position?.sign === AccountBinaryOptionsPositionSignEnum.No
  const { sameSideOrderValue, oppositeSideOrderValue } = computeBOBuySellSide(
    activeOrders,
    isPositionShort,
  )

  return {
    sameSideOrderValue,
    oppositeSideOrderValue:
      oppositeSideOrderValue - (position ? position.size * BO_SETTLEMENT_VALUE : 0),
  }
}

export const computeBOLockedBalance = (
  boPositions: Record<string, BOPosition>,
  boActiveOrders: Record<string, Order[]>,
) =>
  Object.entries(boActiveOrders).reduce((acc, [marketId, orders]) => {
    if (orders.length === 0) {
      return acc
    }

    const { sameSideOrderValue, oppositeSideOrderValue } = getBOOrderValuesForMarket(
      orders,
      boPositions[marketId],
    )

    return acc + Math.max(sameSideOrderValue, oppositeSideOrderValue, 0)
  }, 0)

export const computeBOAvailableToTradeMarket = (
  assetBalances: Record<string, AssetBalance> | undefined,
  tav: number | null,
  imr: number | null,
  boPositionOffset: number,
) => {
  if (!assetBalances || tav === null || imr === null) {
    return null
  }

  const usdcBalance = assetBalances[USDC_ASSET_ID]

  if (!usdcBalance) {
    return boPositionOffset
  }

  if (usdcBalance.margin_mode === 'disabled') {
    return Math.max(0, usdcBalance.balance) + boPositionOffset
  }

  return Math.max(0, Math.min(usdcBalance.margin_balance, tav - imr)) + boPositionOffset
}

export const computeBOAvailableToTradeLimit = (
  availableBalances: Record<string, number | null> | null,
  boPositionOrderOffset: number,
  assetBalances: Record<string, AssetBalance> | undefined,
  boLockedBalance: number | null,
) => {
  if (availableBalances === null || boLockedBalance === null) {
    return null
  }

  const availableBalance = availableBalances[USDC_ASSET_ID]

  if (availableBalance === null) {
    return null
  }

  const usdcBalance = assetBalances?.[USDC_ASSET_ID]

  if (usdcBalance?.margin_mode === 'enabled') {
    return (
      Math.max(
        0,
        Math.min(availableBalance ?? 0, usdcBalance.available_margin_balance - boLockedBalance),
      ) + boPositionOrderOffset
    )
  }

  return (availableBalance ?? 0) + boPositionOrderOffset
}

export const computeBOSliderMaxBaseAmount = (
  orderBookOrders: OrderbookItem[],
  orderType: OrderType,
  availableToTradeMarket: number | null,
  availableToTradeLimit: number | null,
  limitPrice: number,
  canPlaceLimitOrderFullAmount: boolean,
  feeRate: number,
  side: BOSide,
  sellableShares: number,
) => {
  if (side === 'sell') return sellableShares

  if (availableToTradeMarket === null || availableToTradeLimit === null) {
    return 0
  }

  // The fee is at most feeRate × cost, so this budget always leaves room for it
  const feeReserve = 1 + feeRate

  switch (orderType) {
    case OrderType.Market: {
      const maxMatchableBaseAmount = matchQuoteAmount(
        { size_decimals: BO_SIZE_DECIMALS },
        availableToTradeMarket / feeReserve,
        orderBookOrders,
      ).baseAmount

      return floorNumber(maxMatchableBaseAmount * 0.995, BO_SIZE_DECIMALS)
    }
    case OrderType.Limit: {
      if (!limitPrice) {
        return 0
      }

      const maxBaseAmount = availableToTradeLimit / feeReserve / limitPrice
      return floorNumber(
        canPlaceLimitOrderFullAmount ? maxBaseAmount : maxBaseAmount * 0.995,
        BO_SIZE_DECIMALS,
      )
    }
    default:
      return 0
  }
}

const EMPTY_BO_MATCH_INFO: MatchInfo = {
  estPrice: 0,
  baseAmountInputValue: '',
  quoteAmountInputValue: '',
  baseAmount: 0,
  quoteAmount: 0,
}

const computeBOSinglePriceMatchInfo = (
  pinnedInput: OrderPlacementInput,
  pinnedValueInputValue: string,
  sliderMax: number,
  price: number,
): MatchInfo => {
  switch (pinnedInput) {
    case 'base': {
      const baseAmount = floorNumber(Number(pinnedValueInputValue), BO_SIZE_DECIMALS)
      const quoteAmountInputValue =
        !baseAmount || !price ? '' : floorNumber(baseAmount * price, BO_PRICE_DECIMALS).toString()

      return {
        estPrice: price,
        baseAmountInputValue: pinnedValueInputValue,
        quoteAmountInputValue,
        baseAmount,
        quoteAmount: Number(quoteAmountInputValue),
      }
    }
    case 'quote': {
      const quoteAmount = Number(pinnedValueInputValue)
      const baseAmount =
        !quoteAmount || !price ? 0 : floorNumber(quoteAmount / price, BO_SIZE_DECIMALS)

      return {
        estPrice: price,
        baseAmountInputValue: baseAmount ? baseAmount.toString() : '',
        quoteAmountInputValue: pinnedValueInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    case 'percentage': {
      const percentage = Number(pinnedValueInputValue)
      if (!sliderMax || !percentage || !price) {
        return EMPTY_BO_MATCH_INFO
      }

      const baseAmount = floorPercentOf(sliderMax, percentage, BO_SIZE_DECIMALS)
      const quoteAmountInputValue = floorNumber(baseAmount * price, BO_PRICE_DECIMALS).toString()

      return {
        estPrice: price,
        baseAmountInputValue: baseAmount.toString(),
        quoteAmountInputValue,
        baseAmount,
        quoteAmount: Number(quoteAmountInputValue),
      }
    }
    default:
      return null as never
  }
}

const computeBOMarketOrderMatchInfo = (
  pinnedInput: OrderPlacementInput,
  pinnedValueInputValue: string,
  orderBookOrders: OrderbookItem[],
  sliderMax: number,
): MatchInfo => {
  switch (pinnedInput) {
    case 'base': {
      const baseAmount = floorNumber(Number(pinnedValueInputValue), BO_SIZE_DECIMALS)
      const { estPrice, quoteAmount } = matchBaseAmount(
        { price_decimals: BO_PRICE_DECIMALS },
        baseAmount,
        orderBookOrders,
      )

      return {
        estPrice,
        baseAmountInputValue: pinnedValueInputValue,
        quoteAmountInputValue: quoteAmount ? quoteAmount.toString() : '',
        baseAmount,
        quoteAmount,
      }
    }
    case 'percentage': {
      const baseAmount = floorPercentOf(sliderMax, Number(pinnedValueInputValue), BO_SIZE_DECIMALS)
      const { estPrice, quoteAmount } = matchBaseAmount(
        { price_decimals: BO_PRICE_DECIMALS },
        baseAmount,
        orderBookOrders,
      )

      return {
        estPrice,
        baseAmountInputValue: baseAmount ? baseAmount.toString() : '',
        quoteAmountInputValue: quoteAmount ? quoteAmount.toString() : '',
        baseAmount,
        quoteAmount,
      }
    }
    case 'quote': {
      const quoteAmount = Number(pinnedValueInputValue)
      const { estPrice, baseAmount } = matchQuoteAmount(
        { size_decimals: BO_SIZE_DECIMALS },
        quoteAmount,
        orderBookOrders,
      )

      return {
        estPrice,
        baseAmountInputValue: baseAmount ? baseAmount.toString() : '',
        quoteAmountInputValue: pinnedValueInputValue,
        baseAmount,
        quoteAmount,
      }
    }
    default:
      return null as never
  }
}

export const computeBOMatchInfo = (
  orderType: OrderType,
  pinnedInput: OrderPlacementInput,
  pinnedValueInputValue: string,
  limitPrice: number,
  midPrice: number,
  orderBookOrders: OrderbookItem[],
  sliderMax: number,
  availableLiquidity: number,
): MatchInfo => {
  switch (orderType) {
    case OrderType.Market:
      return availableLiquidity !== 0
        ? computeBOMarketOrderMatchInfo(
            pinnedInput,
            pinnedValueInputValue,
            orderBookOrders,
            sliderMax,
          )
        : computeBOSinglePriceMatchInfo(pinnedInput, pinnedValueInputValue, sliderMax, midPrice)
    case OrderType.Limit:
      return computeBOSinglePriceMatchInfo(
        pinnedInput,
        pinnedValueInputValue,
        sliderMax,
        limitPrice,
      )
    default:
      return null as never
  }
}

export const computeBOPositionOffset = (boIsShort: boolean, boPosition?: BOPosition) =>
  computeBOPositionOrderOffset(boIsShort, [], boPosition)

export const computeBOPositionOrderOffset = (
  boIsShort: boolean,
  boOrders: Order[] = [],
  boPosition?: BOPosition,
) => {
  if (!boPosition?.size && boOrders.length === 0) {
    return 0
  }

  const isPositionShort = boPosition?.sign === AccountBinaryOptionsPositionSignEnum.No

  const { sameSideOrderValue, oppositeSideOrderValue } = getBOOrderValuesForMarket(
    boOrders,
    boPosition,
  )

  const directionValue = boIsShort === isPositionShort ? sameSideOrderValue : oppositeSideOrderValue

  const doubleCountedValue = Math.max(sameSideOrderValue, oppositeSideOrderValue, 0)

  return doubleCountedValue - directionValue
}

export const computeBOSellableShares = (outcomeIsShort: boolean, boPosition?: BOPosition) => {
  if (!boPosition?.size) return 0
  if ((boPosition.sign === AccountBinaryOptionsPositionSignEnum.No) !== outcomeIsShort) return 0
  return floorNumber(boPosition.size, BO_SIZE_DECIMALS)
}

export const computeBOOrderPrice = (
  orderType: OrderType,
  limitPrice: number,
  limitPriceInputValue: string,
  sidedMidPrice: number,
  matchInfo: Pick<MatchInfo, 'estPrice'> | undefined,
): number => {
  if (orderType !== OrderType.Limit) return matchInfo?.estPrice ?? sidedMidPrice
  return clampBOPrice(limitPriceInputValue === '' ? sidedMidPrice : limitPrice, {
    price_decimals: BO_PRICE_DECIMALS,
  })
}

export interface BOOrderPayoff {
  payout: number
  profit: number
  roi: number
}

export const computeBOOrderPayoff = (shares: number, cost: number, fee: number): BOOrderPayoff => {
  const payout = shares * BO_SETTLEMENT_VALUE
  const profit = payout - cost - fee
  return { payout, profit, roi: cost + fee > 0 ? (profit / (cost + fee)) * 100 : 0 }
}

export const computeBOSellProceeds = (shares: number, price: number, fee: number): number =>
  Math.max(0, shares * price - fee)

type BOSizeMarket = Pick<EventOrderBookEntry, 'order_quote_limit' | 'min_base_amount'>

export const computeBOWorstExecutionPrice = (
  market: Pick<EventOrderBookEntry, 'price_decimals'> | undefined,
  bestPrice: number | undefined,
  priceToleranceCents: number,
) =>
  bestPrice === undefined || market === undefined
    ? null
    : clampBOPrice(bestPrice + priceToleranceCents / 100, market)

export const getBOOrderAmountErrorType = (
  baseAmount: number,
  price: number,
  market: BOSizeMarket,
  orderType: OrderType,
  timeInForce: BOTimeInForce,
): OrderAmountErrorType | null => {
  if (baseAmount * Math.max(price, 1 - price) > Number(market.order_quote_limit)) {
    return 'maximum'
  }

  if (orderType !== OrderType.Limit || timeInForce === 'ioc') {
    return null
  }

  // BO markets set min_quote_amount to 0.00001 and min_base_amount to 5, so the
  // smallest order that passes the share check (5 shares at the 0.01 tick = 0.05)
  // always passes the quote check too; only the share amount is validated.
  if (baseAmount < Number(market.min_base_amount)) {
    return 'minimum'
  }

  return null
}

export const getBOOrderAmountErrorText = (
  errorType: OrderAmountErrorType,
  market: BOSizeMarket,
) => {
  if (errorType === 'maximum') {
    return {
      key: 'maximum_order_size_warning',
      values: { amount: formatUSD(Number(market.order_quote_limit)) },
    } as const
  }

  return {
    key: 'bo_min_order_size_warning',
    values: { minSize: formatBOSize(Number(market.min_base_amount), false) },
  } as const
}

export const computeBOTooMuchSlippage = (
  orderType: OrderType,
  estPrice: number,
  worstExecutionPrice: number | null,
) =>
  orderType === OrderType.Market && worstExecutionPrice !== null && estPrice > worstExecutionPrice
