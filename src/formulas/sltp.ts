import { OrderTypeEnum } from 'zklighter-perps'

import type { SLTP } from '../store/place-order/createPlaceOrderSlice'
import type { OrderBookDetail } from '../types/compatibility'
import { isPartialNumericInput } from '../utils/common'
import { getTiedSLTPLimitPrice } from '../utils/getTiedSLTPLimitPrice'
import { displayPriceToReal, realPriceToDisplay } from '../utils/multiplier'

export type SLTPInfo = {
  triggerPriceInputValue: string
  amountInputValue: string
  percentageInputValue: string
  limitPriceInputValue: string
  triggerPrice: number
  amount: number
  percentage: number
  limitPrice: number
}

export const DEFAULT_SLTP_INFO: SLTPInfo = {
  triggerPriceInputValue: '',
  amountInputValue: '',
  percentageInputValue: '',
  limitPriceInputValue: '',
  triggerPrice: 0,
  amount: 0,
  percentage: 0,
  limitPrice: 0,
}

export const getSLTPInfo = ({
  orderSize,
  sltp,
  leverage,
  isShort,
  referencePrice,
  market,
  isSL,
  isEntirePosition = false,
}: {
  orderSize: number
  sltp: SLTP
  leverage: number
  isShort: boolean
  referencePrice: number
  market: OrderBookDetail
  isSL: boolean
  isEntirePosition?: boolean
}): SLTPInfo => {
  const limitPrice = displayPriceToReal(sltp.limitPriceInputValue, market, !isShort)
  const effectiveLimitPrice = isEntirePosition
    ? limitPrice
    : getTiedSLTPLimitPrice(
        limitPrice,
        orderSize,
        market,
        isSL ? OrderTypeEnum.StopLossLimit : OrderTypeEnum.TakeProfitLimit,
      )
  const sideSign = (isShort ? -1 : 1) * (isSL ? 1 : -1)

  switch (sltp.pinnedInput) {
    case 'triggerPrice': {
      const triggerPrice = displayPriceToReal(sltp.pinnedValueInputValue, market, !isShort)

      if (!triggerPrice || !referencePrice || !orderSize) {
        return {
          triggerPriceInputValue: sltp.pinnedValueInputValue,
          amountInputValue: '',
          percentageInputValue: '',
          limitPriceInputValue: sltp.limitPriceInputValue,
          triggerPrice,
          amount: 0,
          percentage: 0,
          limitPrice: effectiveLimitPrice,
        }
      }

      const closePrice = effectiveLimitPrice
        ? (isShort ? Math.min : Math.max)(triggerPrice, effectiveLimitPrice)
        : triggerPrice
      const priceDiff = sideSign * (referencePrice - closePrice)
      const priceDiffPercentage = (1 - closePrice / referencePrice) * 100
      const newAmount = priceDiff * orderSize
      const newPercentage = priceDiffPercentage * sideSign * leverage

      return {
        triggerPriceInputValue: sltp.pinnedValueInputValue,
        amountInputValue: newAmount.toFixed(2),
        percentageInputValue: newPercentage.toFixed(2),
        limitPriceInputValue: sltp.limitPriceInputValue,
        triggerPrice,
        amount: newAmount,
        percentage: newPercentage,
        limitPrice: effectiveLimitPrice,
      }
    }
    case 'usd': {
      const newAmount = Number(sltp.pinnedValueInputValue)

      if (isPartialNumericInput(sltp.pinnedValueInputValue) || !referencePrice || !orderSize) {
        return {
          triggerPriceInputValue: '',
          amountInputValue: sltp.pinnedValueInputValue,
          percentageInputValue: '',
          limitPriceInputValue: sltp.limitPriceInputValue,
          triggerPrice: 0,
          amount: newAmount,
          percentage: 0,
          limitPrice: effectiveLimitPrice,
        }
      }

      const newTriggerPrice = referencePrice - newAmount / (sideSign * orderSize)
      const priceDiff = sideSign * (referencePrice - newTriggerPrice)
      const priceDiffPercentage = (priceDiff / referencePrice) * 100
      const percentage = priceDiffPercentage * leverage

      return {
        triggerPriceInputValue: realPriceToDisplay(newTriggerPrice, market).toString(),
        amountInputValue: sltp.pinnedValueInputValue,
        percentageInputValue: percentage.toFixed(2),
        limitPriceInputValue: sltp.limitPriceInputValue,
        triggerPrice: newTriggerPrice,
        amount: newAmount,
        percentage,
        limitPrice: effectiveLimitPrice,
      }
    }
    case 'percent': {
      const newPercentage = Number(sltp.pinnedValueInputValue)

      if (isPartialNumericInput(sltp.pinnedValueInputValue) || !referencePrice || !orderSize) {
        return {
          triggerPriceInputValue: '',
          amountInputValue: '',
          percentageInputValue: sltp.pinnedValueInputValue,
          limitPriceInputValue: sltp.limitPriceInputValue,
          triggerPrice: 0,
          amount: 0,
          percentage: newPercentage,
          limitPrice: effectiveLimitPrice,
        }
      }

      const newTriggerPrice = referencePrice * (1 - sideSign * (newPercentage / leverage / 100))
      const newAmount = (referencePrice - newTriggerPrice) * sideSign * orderSize

      return {
        triggerPriceInputValue: realPriceToDisplay(newTriggerPrice, market).toString(),
        amountInputValue: newAmount.toFixed(2),
        percentageInputValue: sltp.pinnedValueInputValue,
        limitPriceInputValue: sltp.limitPriceInputValue,
        triggerPrice: newTriggerPrice,
        amount: newAmount,
        percentage: newPercentage,
        limitPrice: effectiveLimitPrice,
      }
    }
  }
}
