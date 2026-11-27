import type { TFunction } from 'i18next'

import { AccountAccountTypeEnum } from 'zklighter-perps'
import type { OrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'
import { OrderType } from '../types/order'

export const INIT_DATA_REFETCH_INTERVAL = 5 * 60 * 1000

export const wait = (duration = 1000) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), duration))

export const isZero = (value: string | undefined) => {
  if (value === undefined) return true
  if (Number(value) === 0) return true
  return false
}

export const toNullableNumber = (value: string | null | undefined) =>
  value === undefined || value === null ? null : Number(value)

export const isPartialNumericInput = (value: string) => value === '' || value === '-'

export const sanitizeNumberInput = (
  rawValue: string,
  decimal: number,
  allowNegative: boolean = false,
): string | null => {
  let inputValue = rawValue.replace(/,/g, '.')

  const isNegative = inputValue.startsWith('-')
  if (isNegative && allowNegative) {
    inputValue = inputValue.substring(1)
  }

  inputValue = inputValue.replace(/^0+(?=[0-9])/, '')

  if (inputValue === '.') {
    inputValue = '0.'
  }

  if (decimal === 0) {
    if (!/^[0-9]{0,16}$/.test(inputValue)) {
      return null
    }
  } else {
    let split = inputValue.split('.')

    // 3,301.12 from chart -> 3301.12
    if (split.length > 2) {
      while (split.length > 2 && split[split.length - 1] === '') {
        split.pop()
      }
      split = [split.slice(0, split.length - 1).join(''), split[split.length - 1]!]
      inputValue = split.join('.')
    }

    if (inputValue.length > 16 || !/^[0-9]*\.?[0-9]*$/.test(inputValue) || split.length > 2) {
      return null
    }

    if (split.length === 2 && split[1]!.length > decimal) {
      return null
    }
  }

  return isNegative && allowNegative ? '-' + inputValue : inputValue
}

export const enforcePriceLimit = (value: string, decimal: number) => {
  const baseValue = convertFloatToBase(value, decimal)
  // global price limit on BE
  if (baseValue > 2 ** 32) {
    return false
  }
  return true
}

export const enforceAmountLimit = (value: string, decimal: number) => {
  const baseValue = convertFloatToBase(value, decimal)
  // global amount limit on BE
  if (baseValue > 2 ** 48) {
    return false
  }
  return true
}

type MultiCursor = {
  index: number
  index2: number
}
export const deserializeCursor = (cursor: string): MultiCursor => {
  return JSON.parse(atob(cursor)) as MultiCursor
}

export const convertFloatToBase = (value: string | number, decimals: number) =>
  Math.floor((Number(value) + 0.1 * 10 ** -decimals) * 10 ** decimals)

export const convertBaseToFloat = (value: string | number, decimals: number) =>
  Number(value) / 10 ** decimals

export const PUBLIC_POOL_APR_MIN_TVL = 1000

export const isMaintenanceMode = (t: TFunction, key?: string) => {
  const maintenanceScheduledBody = t(key ?? 'maintenance_scheduled_body', {
    defaultValue: '',
    lng: 'en',
    ns: 'settings',
  }).trim()
  return maintenanceScheduledBody !== ''
}

export const isPublicPoolMaintenanceMode = (t: TFunction, key?: string) => {
  const publicPoolMaintenanceScheduledBody = t(key ?? 'public_pool_maintenance_body', {
    defaultValue: '',
    lng: 'en',
    ns: 'settings',
  }).trim()
  return publicPoolMaintenanceScheduledBody !== ''
}

export const marketToLimitMap = new Map<OrderType, OrderType>([
  [OrderType.Market, OrderType.Limit],
  [OrderType.Twap, OrderType.Limit],
  [OrderType.Scale, OrderType.Limit],
])

export const getShortAddress = (address: string) =>
  address.substring(0, 6).concat('...').concat(address.slice(-4))

export const isMarketSpot = (
  market: Pick<OrderBookDetail, 'market_type'>,
): market is SpotOrderBookDetail => market.market_type === 'spot'

export const getAccountTypeString = (accountType: AccountAccountTypeEnum | undefined): string => {
  switch (accountType) {
    case AccountAccountTypeEnum.Master:
      return 'main'
    case AccountAccountTypeEnum.Sub:
      return 'sub'
    case AccountAccountTypeEnum.PublicPool:
      return 'public'
    case AccountAccountTypeEnum.InsuranceFund:
      return 'lighter_public'
    default:
      return 'unknown'
  }
}

export const API_KEY_INDEXES = {
  DESKTOP: 0,
  QR: 1,
  MOBILE_BROWSER: 2,
  MOBILE_APP: 3,
  STRATEGIES_SERVER: 4,
} as const
