import type { TFunction } from 'i18next'

import type { PlaceOrderSizeErrorText } from '../store/selectors/validation'

export const translateSizeErrorText = (
  errorText: NonNullable<PlaceOrderSizeErrorText>,
  t: TFunction,
) => {
  if (errorText.key === 'maximum_order_size_warning_scale') {
    return t(errorText.key, errorText.values)
  }

  if (errorText.key === 'minimum_order_size_warning_scale') {
    return t(errorText.key, errorText.values)
  }

  if (errorText.key === 'min_order_size_warning') {
    return t(errorText.key, errorText.values)
  }

  if (errorText.key === 'order_size_zero_warning') {
    return t(errorText.key)
  }

  return t(errorText.key, errorText.values)
}
