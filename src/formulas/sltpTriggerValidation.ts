import { enforcePriceLimit } from '../utils/common'

type SLTPTriggerReference = 'limit_price' | 'estimated_price' | 'mark_price'

export type InvalidSLTPTriggerPriceKey =
  | 'stop_price_below_limit_price'
  | 'stop_price_above_limit_price'
  | 'stop_price_below_estimated_price'
  | 'stop_price_above_estimated_price'
  | 'sl_trigger_price_below_mark_price'
  | 'sl_trigger_price_above_mark_price'
  | 'tp_price_above_limit_price'
  | 'tp_price_below_limit_price'
  | 'tp_price_above_estimated_price'
  | 'tp_price_below_estimated_price'
  | 'tp_trigger_price_above_mark_price'
  | 'tp_trigger_price_below_mark_price'

export type SLTriggerPriceLiqWarningKey =
  | 'sl_trigger_price_below_liq_price'
  | 'sl_trigger_price_above_liq_price'

export const getInvalidSLTPTriggerPriceKey = (
  isSL: boolean,
  isShort: boolean,
  triggerPrice: number,
  referencePrice: number,
  reference: SLTPTriggerReference,
): InvalidSLTPTriggerPriceKey | null => {
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

export type InvalidSLTPPriceText = {
  errorText?:
    | 'sl_price_above_zero'
    | 'tp_price_above_zero'
    | 'sl_price_too_high'
    | 'tp_price_too_high'
    | InvalidSLTPTriggerPriceKey
  warningText?: SLTriggerPriceLiqWarningKey
} | null

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
    return { errorText: isSL ? 'sl_price_above_zero' : 'tp_price_above_zero' }
  }

  if (!enforcePriceLimit(triggerPriceInputValue, displayPriceDecimals)) {
    return { errorText: isSL ? 'sl_price_too_high' : 'tp_price_too_high' }
  }

  const referencePriceError = getInvalidSLTPTriggerPriceKey(
    isSL,
    isShort,
    triggerPrice,
    estPrice,
    isLimit ? 'limit_price' : 'estimated_price',
  )
  if (referencePriceError) {
    return { errorText: referencePriceError }
  }

  const markPriceError =
    !isLimit && getInvalidSLTPTriggerPriceKey(isSL, isShort, triggerPrice, markPrice, 'mark_price')
  if (markPriceError) {
    return { errorText: markPriceError }
  }

  const liqWarning =
    isSL &&
    (!isShort || !isLimit) &&
    getSLTriggerPriceLiqWarningKey(isShort, triggerPrice, liquidationPrice)
  if (liqWarning) {
    return { warningText: liqWarning }
  }

  return null
}

export const getSLTriggerPriceLiqWarningKey = (
  isShort: boolean,
  triggerPrice: number,
  liquidationPrice: number,
): SLTriggerPriceLiqWarningKey | null => {
  if (isShort) {
    return triggerPrice > liquidationPrice ? 'sl_trigger_price_above_liq_price' : null
  }

  return triggerPrice < liquidationPrice ? 'sl_trigger_price_below_liq_price' : null
}
