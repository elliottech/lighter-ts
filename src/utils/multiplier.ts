import type { ExtendedCandlestick } from '../store/orderbook/types'
import type { OrderBookDetail } from '../types/compatibility'

import { ceilNumber, floorNumber } from './precision'

const multiplier_precision_lookup: Record<string, number> = {}

const getMultiplierPrecision = (multiplier?: string) => {
  if (!multiplier) return 0
  if (multiplier_precision_lookup[multiplier] !== undefined) {
    return multiplier_precision_lookup[multiplier]
  }

  const precision = multiplier.includes('.')
    ? multiplier.replace(/0+$/, '').split('.')[1]?.length
    : 0

  multiplier_precision_lookup[multiplier] = precision ?? 0
  return precision ?? 0
}

const TESTING_DEFAULT_MULTIPLIER =
  (typeof window !== 'undefined' && window.location?.search
    ? new URLSearchParams(window.location.search).get('ui_multiplier')
    : null) ?? '1'

export const realSizeToDisplay = (
  realSize: number | string,
  params: { multiplier: string; display_size_decimals: number },
) => {
  if (Number(realSize) === 0) return 0
  const multiplierPrecision = getMultiplierPrecision(
    params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER,
  )

  return ceilNumber(
    Number(realSize) * Number(params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER) -
      0.1 * 10 ** -((params?.display_size_decimals ?? 0) + multiplierPrecision),
    params?.display_size_decimals ?? 0,
  )
}

export const realPriceToDisplay = (
  realPrice: number | string,
  params: { multiplier: string; display_price_decimals: number },
) => {
  if (Number(realPrice) === 0) return 0
  const multiplierPrecision = getMultiplierPrecision(
    params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER,
  )
  return ceilNumber(
    Number(realPrice) / Number(params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER) -
      0.1 * 10 ** -((params?.display_price_decimals ?? 0) + multiplierPrecision),
    params?.display_price_decimals ?? 0,
  )
}

export const displaySizeToReal = (
  displaySize: number | string,
  params: { multiplier: string; size_decimals: number },
) => {
  if (Number(displaySize) === 0) return 0
  const multiplierPrecision = getMultiplierPrecision(
    params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER,
  )
  return floorNumber(
    Number(displaySize) / Number(params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER) +
      0.1 * 10 ** -((params?.size_decimals ?? 0) + multiplierPrecision),
    params?.size_decimals ?? 0,
  )
}

export const displayPriceToReal = (
  displayPrice: number | string,
  params: { multiplier: string; price_decimals: number; display_price_decimals: number },
  isShort: boolean,
) => {
  const multiplierPrecision = getMultiplierPrecision(
    params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER,
  )
  const ans = floorNumber(
    Number(displayPrice) * Number(params?.multiplier ?? TESTING_DEFAULT_MULTIPLIER) +
      0.1 * 10 ** -((params?.display_price_decimals ?? 0) + multiplierPrecision),
    params?.price_decimals ?? 0,
  )

  if (!isShort) {
    return ans
  }

  const isValid = realPriceToDisplay(ans, params) === Number(displayPrice)
  if (isValid) {
    return ans
  } else {
    return floorNumber(
      ans + 1.1 * 10 ** -(params?.price_decimals ?? 0),
      params?.price_decimals ?? 0,
    )
  }
}

export const realCandlesticksToDisplay = (
  candlesticks: ExtendedCandlestick[],
  market: Pick<OrderBookDetail, 'multiplier' | 'display_price_decimals' | 'display_size_decimals'>,
) =>
  candlesticks.map((candlestick) => ({
    ...candlestick,
    open: realPriceToDisplay(candlestick.open, market),
    high: realPriceToDisplay(candlestick.high, market),
    low: realPriceToDisplay(candlestick.low, market),
    close: realPriceToDisplay(candlestick.close, market),
    volumeBase: candlestick.volumeBase
      ? realSizeToDisplay(candlestick.volumeBase, market)
      : candlestick.volumeBase,
  }))

export const getDisplayDecimals = (
  market: Pick<OrderBookDetail, 'price_decimals' | 'size_decimals' | 'multiplier'>,
) => ({
  display_price_decimals:
    market.price_decimals + (Number(market.multiplier ?? TESTING_DEFAULT_MULTIPLIER) > 1 ? 1 : 0),
  display_size_decimals:
    market.size_decimals + (Number(market.multiplier ?? TESTING_DEFAULT_MULTIPLIER) < 1 ? 1 : 0),
})
