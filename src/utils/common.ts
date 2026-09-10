import type { TFunction } from 'i18next'
import type { PnLEntry } from 'zklighter-perps'

import { SubAccountType } from '../store/types'
import type { OrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'
import { OrderType } from '../types/order'
import type { ExtendedUserTier } from '../types/user-tiers'

import { getPlanFees } from './fees'
import type { TypeSelectorOption } from './filters'

export const INIT_DATA_REFETCH_INTERVAL = 5 * 60 * 1000

export const wait = (duration = 1000) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), duration))

export const isZero = (value: string | undefined) => {
  if (value === undefined) return true
  if (Number(value) === 0) return true
  return false
}

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
    if (!/^[0-9]{0,12}$/.test(inputValue)) {
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

    if (inputValue.length > 12 || !/^[0-9]*\.?[0-9]*$/.test(inputValue) || split.length > 2) {
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

const FEE_TICK = 1_000_000
export const getFeePercentage = (fee: number) => fee / FEE_TICK

// Get fee percentages from AccountLimits if available, otherwise fall back to tier-based calculation
export const getFeePercentageFromTier = (
  tier: ExtendedUserTier,
  feeTicks: { takerFeeTick: number; makerFeeTick: number } | null,
) => {
  // If fee ticks are provided, use them (for premium accounts with backend-provided fees)
  if (feeTicks) {
    return {
      taker: getFeePercentage(feeTicks.takerFeeTick),
      maker: getFeePercentage(feeTicks.makerFeeTick),
    }
  }

  return getPlanFees(tier)
}

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

export const getPnlByKey = (
  pnl: PnLEntry | undefined,
  key: 'total_pnl' | 'trade_pnl' | 'trade_spot_pnl' | 'pool_pnl' | 'staking_pnl',
) => {
  if (!pnl) {
    return 0
  }

  switch (key) {
    case 'total_pnl': {
      return pnl.trade_pnl + pnl.trade_spot_pnl + pnl.pool_pnl + pnl.staking_pnl
    }
    case 'trade_pnl': {
      return pnl.trade_pnl
    }
    case 'trade_spot_pnl': {
      return pnl.trade_spot_pnl
    }
    case 'pool_pnl': {
      return pnl.pool_pnl
    }
    case 'staking_pnl': {
      return pnl.staking_pnl
    }
    default: {
      return 0
    }
  }
}

export const getInflowByKey = (
  pnl: PnLEntry | undefined,
  key: 'total_pnl' | 'trade_pnl' | 'trade_spot_pnl' | 'pool_pnl' | 'staking_pnl',
) => {
  if (!pnl) {
    return 0
  }

  switch (key) {
    case 'total_pnl': {
      return pnl.inflow + pnl.spot_inflow - pnl.pool_outflow
    }
    case 'trade_pnl': {
      return pnl.inflow - pnl.pool_outflow
    }
    case 'trade_spot_pnl': {
      return pnl.spot_inflow
    }
    case 'pool_pnl': {
      return pnl.pool_inflow
    }
    case 'staking_pnl': {
      return pnl.staking_inflow
    }
    default: {
      return 0
    }
  }
}

export const computeAccountPnl = (pnLEntries: PnLEntry[] | undefined, type: TypeSelectorOption) =>
  (pnLEntries ?? [])
    .map((d, index, arr) =>
      index === arr.length - 1
        ? [0, 0]
        : [
            arr[index + 1]?.timestamp ?? 0,
            getPnlByKey(arr[index + 1], type) - getPnlByKey(d, type),
          ],
    )
    .slice(0, -1) as [number, number][] // filter undefined values

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

export const getAccountTypeString = (accountType: SubAccountType | undefined): string => {
  switch (accountType) {
    case SubAccountType.Main:
      return 'main'
    case SubAccountType.Sub:
      return 'sub'
    case SubAccountType.Public:
      return 'public'
    case SubAccountType.LighterPublic:
      return 'lighter_public'
    default:
      return 'unknown'
  }
}

export const computeStackedEquity = (
  balanceEntries: PnLEntry[],
): { timestamp: number; spot: number; perps: number; pools: number; staking: number }[] =>
  balanceEntries.map((entry) => ({
    timestamp: entry.timestamp,
    spot: entry.trade_spot_pnl,
    perps: entry.trade_pnl,
    pools: entry.pool_pnl,
    staking: entry.staking_pnl,
  }))

export const API_KEY_INDEXES = {
  DESKTOP: 0,
  QR: 1,
  MOBILE_BROWSER: 2,
  MOBILE_APP: 3,
} as const
