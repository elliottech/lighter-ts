import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInSeconds,
} from 'date-fns'
import type { TFunction } from 'i18next'

import type { AssetMeta, OrderBookDetail } from '../types/compatibility'
import { BO_PRICE_DECIMALS, BO_SIZE_DECIMALS, type PriceToBeatMove } from './bo'
import { isMarketSpot } from './common'
import { realOraclePriceToDisplay, realPriceToDisplay, realSizeToDisplay } from './multiplier'

// `Number#toLocaleString(locales, options)` may construct a fresh `Intl.NumberFormat`
// for each call. These formatters are used in hot paths (e.g. the order book
// formats several cells per row and re-renders multiple times per second), so we
// cache one formatter per (locale, options) combination and reuse it. The set of
// distinct option shapes is tiny and bounded, so the cache stays small.
const numberFormatCache = new Map<string, Intl.NumberFormat>()
const MAX_NUMBER_FORMAT_CACHE = 256
export const formatNumber = (
  value: number,
  options?: Intl.NumberFormatOptions,
  locale = 'en-US',
) => {
  const key = `${locale}:${JSON.stringify(options ?? {})}`
  let formatter = numberFormatCache.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    if (numberFormatCache.size >= MAX_NUMBER_FORMAT_CACHE) {
      // Evict the oldest entry (Map preserves insertion order).
      numberFormatCache.delete(numberFormatCache.keys().next().value!)
    }
    numberFormatCache.set(key, formatter)
  }
  return formatter.format(value)
}

export const formatUSD = (
  value: number | string,
  showCurrency = true,
  fractionDigits: number = 2,
  compact = false,
) =>
  formatNumber(Number(value), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    notation: compact ? 'compact' : 'standard',
    roundingMode: 'floor',
    ...(showCurrency && { style: 'currency', currency: 'USD' }),
  })

export const formatMarketCap = (value: number, currency = 'USD') =>
  formatNumber(value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    notation: 'compact',
    roundingMode: 'floor',
    style: 'currency',
    currency,
  })

export const formatPercentage = (
  value: number,
  { minimumFractionDigits, maximumFractionDigits, ...rest }: Intl.NumberFormatOptions = {},
) =>
  formatNumber(value, {
    style: 'percent',
    minimumFractionDigits: minimumFractionDigits ?? 0,
    maximumFractionDigits: maximumFractionDigits ?? 2,
    roundingMode: 'floor',
    ...rest,
  })

export const formatLeverage = (value: number) =>
  `${formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}x`

export const formatAssetPrice = (
  value: number,
  asset: Pick<AssetMeta, 'multiplier' | 'display_price_decimals'>,
) => {
  if (!Number.isInteger(asset.display_price_decimals)) {
    return '-'
  }

  return formatNumber(realPriceToDisplay(value, asset), {
    minimumFractionDigits: asset.display_price_decimals,
    maximumFractionDigits: asset.display_price_decimals,
  })
}

export const formatMarketPrice = (
  value: number | string,
  market: Pick<OrderBookDetail, 'display_price_decimals' | 'multiplier'>,
  trimmedDecimals = 0,
) => {
  if (!Number.isInteger(market.display_price_decimals)) {
    return '-'
  }

  const marketPriceDecimals = Math.max(market.display_price_decimals - trimmedDecimals, 0)

  return formatNumber(realPriceToDisplay(value, market), {
    minimumFractionDigits: marketPriceDecimals,
    maximumFractionDigits: marketPriceDecimals,
  })
}

const ORACLE_MAX_DISPLAY_DECIMALS = 8

// Oracle prices (e.g. Chainlink) aren't exchange ticks, so they round half instead of up like formatMarketPrice.
export const formatOraclePrice = (
  value: number | string,
  market: Pick<OrderBookDetail, 'display_price_decimals' | 'multiplier'>,
  decimals = market.display_price_decimals,
) => {
  if (!Number.isInteger(decimals)) {
    return '-'
  }
  return formatNumber(realOraclePriceToDisplay(value, market), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

// Oracle feeds carry far more decimals than the market displays, and the outcome is decided on all of them. The
// market's decimals, extended (up to ORACLE_MAX_DISPLAY_DECIMALS) until prices that differ no longer read the same.
export const getOracleDisplayDecimals = (
  prices: readonly (number | string | null | undefined)[],
  market: Pick<OrderBookDetail, 'display_price_decimals' | 'multiplier'>,
) => {
  const base = market.display_price_decimals
  if (!Number.isInteger(base)) return base
  const distinct = [...new Set(prices.filter((price) => price != null).map(Number))]
  for (let decimals = base; decimals < ORACLE_MAX_DISPLAY_DECIMALS; decimals++) {
    const shown = new Set(distinct.map((price) => formatOraclePrice(price, market, decimals)))
    if (shown.size === distinct.length) return decimals
  }
  return Math.max(base, ORACLE_MAX_DISPLAY_DECIMALS)
}

export const formatBOPrice = (value: number | string, trimmedDecimals = 0) => {
  const decimals = Math.max(BO_PRICE_DECIMALS - 2 - trimmedDecimals, 0)
  const displayPrice = Number(value) * 100

  return `${formatNumber(displayPrice, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}¢`
}

export const formatMarketSize = (
  value: number | string,
  market: Pick<OrderBookDetail, 'multiplier' | 'display_size_decimals'>,
  keepTrailingZeros = true,
) => {
  if (!Number.isInteger(market.display_size_decimals)) {
    return '-'
  }

  return formatNumber(realSizeToDisplay(value, market), {
    minimumFractionDigits: keepTrailingZeros ? market.display_size_decimals : 0,
    maximumFractionDigits: market.display_size_decimals,
  })
}

export const formatBOSize = (value: number | string, keepTrailingZeros = true) =>
  formatNumber(Number(value), {
    minimumFractionDigits: keepTrailingZeros ? BO_SIZE_DECIMALS : 0,
    maximumFractionDigits: BO_SIZE_DECIMALS,
  })

export const formatQuoteAmount = (
  value: number | string,
  market: Pick<OrderBookDetail, 'display_price_decimals' | 'market_type'>,
  options?: { compact?: boolean; decimals?: number },
) => {
  const compact = options?.compact ?? false
  const decimals = options?.decimals ?? market.display_price_decimals

  if (isMarketSpot(market)) {
    if (!Number.isInteger(decimals)) {
      return '-'
    }

    return `${formatNumber(Number(value), {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      roundingMode: 'floor',
      notation: compact ? 'compact' : 'standard',
    })} ${getQuoteSymbol(market)}`
  }

  return formatNumber(Number(value), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    notation: compact ? 'compact' : 'standard',
    roundingMode: 'floor',
    style: 'currency',
    currency: 'USD',
  })
}

export const formatAssetSize = (
  value: number | string,
  asset: Pick<AssetMeta, 'size_decimals' | 'multiplier' | 'display_size_decimals'>,
) => {
  if (!Number.isInteger(asset.display_size_decimals)) {
    return '-'
  }

  return formatNumber(realSizeToDisplay(value, asset), {
    minimumFractionDigits: 0,
    maximumFractionDigits: asset.display_size_decimals,
    roundingMode: 'floor',
  })
}

export const formatOpenInterest = (
  value: number | string,
  options?: { oneSided?: boolean; compact?: boolean; showCurrency?: boolean },
) => {
  const oneSided = options?.oneSided ?? false
  const showCurrency = options?.showCurrency ?? true
  const compact = options?.compact ?? true

  return formatNumber(Number(oneSided ? value : Number(value) * 2), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    notation: compact ? 'compact' : 'standard',
    ...(showCurrency && { style: 'currency', currency: 'USD' }),
  })
}

/**
 *
 * This function has optional t function because it is used in memo functions of tables to check if the value has changed.
 * If the value doesnt change, it will not re-render the component.
 * If the t function is not provided, it will return a string with the key and value
 *
 * formatRemainingTime without underscore is typed and exported for use in view components.
 */
const _formatRemainingTime = (dateString: string | number, t: TFunction): string | undefined => {
  const now = new Date()
  const futureDate = new Date(dateString)

  if (futureDate <= now) return undefined

  const seconds = differenceInSeconds(futureDate, now)
  if (seconds < 60) {
    return t('count_seconds_short', { count: seconds })
  }

  const minutes = differenceInMinutes(futureDate, now)
  if (minutes < 60) {
    return (
      `${t('count_minutes_short', { count: minutes })}` +
      (seconds % 60 > 0 ? ` ${t('count_seconds_short', { count: seconds % 60 })}` : '')
    )
  }

  const hours = differenceInHours(futureDate, now)
  if (hours < 24) {
    return (
      `${t('count_hours_short', { count: hours })}` +
      (minutes % 60 > 0 ? ` ${t('count_minutes_short', { count: minutes % 60 })}` : '')
    )
  }

  const days = differenceInDays(futureDate, now)
  return t('count_days_short', { count: days })
}

export const formatRemainingTime: (
  dateString: string | number,
  t: TFunction,
) => string | undefined = _formatRemainingTime

export const getBaseSymbol = (market: OrderBookDetail) =>
  isMarketSpot(market) ? market.symbol.split('/')[0]! : market.symbol

export const getBackendBaseSymbol = (market: OrderBookDetail) =>
  isMarketSpot(market) ? market.backend_symbol.split('/')[0]! : market.backend_symbol

export const getQuoteSymbol = (market: OrderBookDetail) =>
  isMarketSpot(market) ? market.symbol.split('/')[1]! : 'USD'

export const formatAvailableToTrade = (
  availableToTrade: number | null,
  isShort: boolean,
  market: OrderBookDetail,
) => {
  if (availableToTrade === null) {
    return '-'
  }

  if (isMarketSpot(market)) {
    return isShort
      ? `${formatMarketSize(availableToTrade, market)} ${getBaseSymbol(market)}`
      : `${formatQuoteAmount(availableToTrade, market)}`
  }

  return formatUSD(availableToTrade)
}

export const formatClock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`
}

export type TimeAgoGranularity = 'seconds' | 'minutes'

export const formatTimeAgo = (
  timestamp: number,
  t: TFunction,
  granularity: TimeAgoGranularity = 'minutes',
  now = Date.now(),
): string => {
  const timestampMs = timestamp < 1e12 ? timestamp * 1000 : timestamp
  const seconds = Math.max(0, Math.floor((now - timestampMs) / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (granularity === 'seconds' && minutes === 0) {
    return t('time_ago', { time: t('count_seconds_short', { count: seconds }) })
  }
  if (minutes < 60) {
    return t('time_ago', { time: t('count_minutes_short', { count: minutes }) })
  }
  if (hours < 24) {
    return t('time_ago', { time: t('count_hours_short', { count: hours }) })
  }
  return t('time_ago', { time: t('count_days_short', { count: Math.floor(hours / 24) }) })
}

export const formatDuration = (seconds: number) => {
  if (!seconds) return '0m'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)

  const parts = []
  if (days > 0) parts.push(`${days} ${days > 1 ? 'days' : 'day'}`)
  if (hours > 0) parts.push(`${hours} ${hours > 1 ? 'hours' : 'hour'}`)
  if (minutes > 0) parts.push(`${minutes} ${minutes > 1 ? 'minutes' : 'minute'}`)

  if (parts.length === 0) return '<1m'

  return parts.join(' ')
}

export const formatBOMovePercent = (bps: number) =>
  formatNumber(Math.abs(bps) / 10_000, { style: 'percent', maximumFractionDigits: 3 })

export const formatBOMoveSign = (move: PriceToBeatMove) => (move.distance >= 0 ? '+' : '-')

export const formatBOMovePercentValue = (move: PriceToBeatMove & { bps: number }) =>
  formatNumber(move.bps / 10_000, {
    style: 'percent',
    maximumFractionDigits: 3,
    signDisplay: 'always',
  })

export const formatSignedPriceToBeatMove = (
  move: PriceToBeatMove,
  formatPrice: (price: number) => string,
) => {
  const distance = `${formatBOMoveSign(move)}$${formatPrice(Math.abs(move.distance))}`
  return move.bps === null
    ? distance
    : `${distance} (${formatBOMovePercentValue({ ...move, bps: move.bps })})`
}
