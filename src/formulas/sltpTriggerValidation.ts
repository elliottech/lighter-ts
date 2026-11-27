import { enforcePriceLimit } from '../utils/common'

type SLTPTriggerReference = 'limit_price' | 'estimated_price' | 'mark_price'

export type InvalidSLTriggerPriceKey =
  | 'stop_price_below_limit_price'
  | 'stop_price_above_limit_price'
  | 'stop_price_below_estimated_price'
  | 'stop_price_above_estimated_price'
  | 'sl_trigger_price_below_mark_price'
  | 'sl_trigger_price_above_mark_price'
  | 'sl_trigger_price_below_liq_price'
  | 'sl_trigger_price_above_liq_price'

export type InvalidTPTriggerPriceKey =
  | 'tp_price_above_limit_price'
  | 'tp_price_below_limit_price'
  | 'tp_price_above_estimated_price'
  | 'tp_price_below_estimated_price'
  | 'tp_trigger_price_above_mark_price'
  | 'tp_trigger_price_below_mark_price'

export const getInvalidSLTPTriggerPriceKey = (
  isSL: boolean,
  isShort: boolean,
  triggerPrice: number,
  referencePrice: number,
  reference: SLTPTriggerReference,
): InvalidSLTriggerPriceKey | InvalidTPTriggerPriceKey | null => {
  const isInvalid = isSL !== isShort ? triggerPrice > referencePrice : triggerPrice < referencePrice

  if (!isInvalid) {
    return null
  }

  if (isSL) {
    switch (reference) {
      case 'limit_price':
        return isShort ? 'stop_price_above_limit_price' : 'stop_price_below_limit_price'
      case 'estimated_price':
        return isShort ? 'stop_price_above_estimated_price' : 'stop_price_below_estimated_price'
      case 'mark_price':
        return isShort ? 'sl_trigger_price_above_mark_price' : 'sl_trigger_price_below_mark_price'
    }
  }

  switch (reference) {
    case 'limit_price':
      return isShort ? 'tp_price_below_limit_price' : 'tp_price_above_limit_price'
    case 'estimated_price':
      return isShort ? 'tp_price_below_estimated_price' : 'tp_price_above_estimated_price'
    case 'mark_price':
      return isShort ? 'tp_trigger_price_below_mark_price' : 'tp_trigger_price_above_mark_price'
  }
}

export type InvalidSLTPPriceText =
  | 'sl_price_above_zero'
  | 'tp_price_above_zero'
  | 'sl_price_too_high'
  | 'tp_price_too_high'
  | InvalidSLTriggerPriceKey
  | InvalidTPTriggerPriceKey
  | null

export const getInvalidSLTPPriceText = ({
  isSL,
  isShort,
  isLimit,
  estPrice,
  triggerPrice,
  triggerPriceInputValue,
  markPrice,
  displayPriceDecimals,
  liquidationPrice,
}: {
  isSL: boolean
  isShort: boolean
  isLimit: boolean
  estPrice: number
  triggerPrice: number
  triggerPriceInputValue: string
  markPrice: number | null
  displayPriceDecimals: number
  liquidationPrice: number
}): InvalidSLTPPriceText => {
  if (!estPrice || !triggerPriceInputValue || !markPrice) {
    return null
  }

  if (triggerPrice <= 0) {
    return isSL ? 'sl_price_above_zero' : 'tp_price_above_zero'
  }

  if (!enforcePriceLimit(triggerPriceInputValue, displayPriceDecimals)) {
    return isSL ? 'sl_price_too_high' : 'tp_price_too_high'
  }

  const referencePriceError = getInvalidSLTPTriggerPriceKey(
    isSL,
    isShort,
    triggerPrice,
    estPrice,
    isLimit ? 'limit_price' : 'estimated_price',
  )
  if (referencePriceError) {
    return referencePriceError
  }

  const markPriceError =
    !isLimit && getInvalidSLTPTriggerPriceKey(isSL, isShort, triggerPrice, markPrice, 'mark_price')
  if (markPriceError) {
    return markPriceError
  }

  const liqError =
    isSL &&
    (!isShort || !isLimit) &&
    getInvalidSLTriggerPriceLiqKey(isShort, triggerPrice, liquidationPrice)
  if (liqError) {
    return liqError
  }

  return null
}

export const getInvalidSLTriggerPriceLiqKey = (
  isShort: boolean,
  triggerPrice: number,
  liquidationPrice: number,
): InvalidSLTriggerPriceKey | null => {
  if (isShort) {
    return triggerPrice > liquidationPrice ? 'sl_trigger_price_above_liq_price' : null
  }

  return triggerPrice < liquidationPrice ? 'sl_trigger_price_below_liq_price' : null
}
