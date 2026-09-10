import { mapValues, partition } from 'lodash-es'
import { OrderTypeEnum } from 'zklighter-perps'

import { errorReporting } from '../lib/errorReporting'
import { USDC_ASSET_ID } from '../store/orderbook/selectors'
import type { AssetBalance, Order, Position } from '../store/types'
import type { AssetMeta, OrderBookDetail, PerpsOrderBookDetail } from '../types/compatibility'
import { MarginMode } from '../types/MarginMode'
import { floorNumber } from '../utils/precision'

import { computePositionPnl, marginFractionToPercentage } from './common'

export const doesOrderUseMargin = (order: Pick<Order, 'type' | 'reduce_only'>) =>
  order.type === OrderTypeEnum.Limit

export const computeOrderMargin = (order: Order, imf: number) => {
  if (!doesOrderUseMargin(order)) {
    return null
  }

  return order.remaining_base_amount * order.price * marginFractionToPercentage(imf)
}

const computeBuySellSide = (
  activeOrders: Pick<
    Order,
    'is_ask' | 'remaining_base_amount' | 'price' | 'type' | 'reduce_only'
  >[],
  isPositionShort: boolean,
) => {
  const [sellOrders, buyOrders] = partition(
    activeOrders.filter(doesOrderUseMargin),
    (order) => order.is_ask,
  )
  const buyValue = buyOrders.reduce(
    (acc, order) => acc + order.remaining_base_amount * order.price,
    0,
  )
  const sellValue = sellOrders.reduce(
    (acc, order) => acc + order.remaining_base_amount * order.price,
    0,
  )

  return {
    sameSideOrderValue: isPositionShort ? sellValue : buyValue,
    oppositeSideOrderValue: isPositionShort ? buyValue : sellValue,
  }
}

const getOrderMarginsForMarket = (
  imf: number,
  markPrice: number,
  activeOrders: Pick<
    Order,
    'is_ask' | 'remaining_base_amount' | 'price' | 'type' | 'reduce_only'
  >[],
  position?: Position,
) => {
  const { sameSideOrderValue, oppositeSideOrderValue } = computeBuySellSide(
    activeOrders,
    position?.sign === -1,
  )

  const sameSideOrderMargin = sameSideOrderValue * imf
  let oppositeSideOrderMargin = oppositeSideOrderValue * imf

  if (!position?.position) {
    return { sameSideOrderMargin, oppositeSideOrderMargin }
  }

  const positionValue = position.position * markPrice

  if (position.margin_mode === MarginMode.CROSS) {
    oppositeSideOrderMargin -= 2 * positionValue * imf
  } else {
    const isolatedTAV = position.allocated_margin + computePositionPnl(position, markPrice)
    oppositeSideOrderMargin -= positionValue * imf + isolatedTAV
  }

  return { sameSideOrderMargin, oppositeSideOrderMargin }
}

export const computeAvailableOrderMargin = (
  perpsOrderBookMetas: Record<
    string,
    Pick<PerpsOrderBookDetail, 'default_initial_margin_fraction'>
  >,
  markPrices: Record<string, number>,
  positions: Record<string, Position> | undefined,
  activeOrders: Record<
    string,
    Pick<Order, 'is_ask' | 'remaining_base_amount' | 'price' | 'type' | 'reduce_only'>[]
  >,
  assets: Record<string, AssetMeta>,
  assetBalances: Record<string, AssetBalance> | undefined,
  indexPrices: Record<string, number>,
  tav: number | null,
  imr: number | null,
) => {
  if (tav === null || imr === null || !positions || !assetBalances) {
    return null
  }

  const orderMargin = Object.entries(perpsOrderBookMetas).reduce((acc, [marketId, meta]) => {
    const position = positions[marketId]
    const markPrice = markPrices[marketId] ?? 0
    const imf = marginFractionToPercentage(
      position?.initial_margin_fraction ?? meta.default_initial_margin_fraction,
    )
    const orders = activeOrders[marketId] ?? []

    if (!position?.position && orders.length === 0) {
      return acc
    }

    const { sameSideOrderMargin, oppositeSideOrderMargin } = getOrderMarginsForMarket(
      imf,
      markPrice,
      orders,
      position,
    )

    return acc + Math.max(sameSideOrderMargin, oppositeSideOrderMargin)
  }, 0)

  const spotOrderMargin = Object.values(assetBalances).reduce((acc, assetBalance) => {
    const asset = assets[assetBalance.asset_id]
    const indexPrice = indexPrices[assetBalance.asset_id] ?? 0
    const lockedPerpsBalance = Math.max(0, assetBalance.locked_balance - assetBalance.balance)

    if (!asset) {
      errorReporting.captureException(new Error('Missing asset meta for asset balance'), {
        tags: {
          source: 'computeAvailableOrderMargin',
          assetId: String(assetBalance.asset_id),
        },
      })
      return acc
    }

    if (assetBalance.margin_mode === 'disabled') {
      return acc
    }

    return acc + lockedPerpsBalance * indexPrice * Number(asset.loan_to_value)
  }, 0)

  return tav - imr - orderMargin - spotOrderMargin
}

export const computePositionMarginOffset = (
  isSpot: boolean,
  isShort: boolean,
  imf: number,
  markPrice: number | null,
  position?: Position,
) => computePositionOrderMarginOffset(isSpot, isShort, imf, markPrice, [], position)

export const computePositionOrderMarginOffset = (
  isSpot: boolean,
  isShort: boolean,
  imf: number,
  markPrice: number | null,
  orders: Order[] = [],
  position?: Position,
) => {
  if (isSpot || (!position?.position && orders.length === 0)) {
    return 0
  }

  const isPositionShort = position?.sign === -1

  const { sameSideOrderMargin, oppositeSideOrderMargin } = getOrderMarginsForMarket(
    marginFractionToPercentage(imf),
    markPrice ?? 0,
    orders,
    position,
  )

  // when going in the same direction as the position, we care about that margin
  const directionOffset =
    isShort === isPositionShort ? sameSideOrderMargin : oppositeSideOrderMargin

  // this function is used in conjunction with computeAvailableOrderMargin where this value is
  // being added for this market for non-trading purposes so we need to subtract it here
  const doubleCountedValue = Math.max(sameSideOrderMargin, oppositeSideOrderMargin)

  return doubleCountedValue - directionOffset
}

export const computeClassicAvailablePerpsUSDCToTransfer = (
  availableOrderMargin: number | null,
  assetBalances: Record<string, AssetBalance> | undefined,
) => {
  if (availableOrderMargin === null || !assetBalances) {
    return null
  }

  return floorNumber(
    Math.max(0, Math.min(assetBalances[USDC_ASSET_ID]?.margin_balance ?? 0, availableOrderMargin)),
    2,
  )
}

export const computeAvailableBalancesToTransfer = (
  assetMetas: Record<string, AssetMeta>,
  assetBalances: Record<string, AssetBalance> | undefined,
  indexPrices: Record<string, number>,
  availableOrderMargin: number | null,
) => {
  if (!assetBalances) {
    return null
  }

  return mapValues(assetBalances, (assetBalance) => {
    const asset = assetMetas[assetBalance.asset_id]
    const indexPrice = indexPrices[assetBalance.asset_id]

    if (!asset) {
      errorReporting.captureException(new Error('Missing asset meta for asset balance'), {
        tags: {
          source: 'computeAvailableBalancesToTransfer',
          assetId: String(assetBalance.asset_id),
        },
      })
      return null
    }

    if (assetBalance.margin_mode === 'disabled') {
      return floorNumber(assetBalance.available_balance, asset.size_decimals)
    }

    if (availableOrderMargin === null || !indexPrice) {
      return null
    }

    const availablePerpsBalance = Math.max(
      0,
      Math.min(
        assetBalance.available_margin_balance,
        availableOrderMargin / indexPrice / Number(asset.loan_to_value),
      ),
    )

    return floorNumber(assetBalance.available_balance + availablePerpsBalance, asset.size_decimals)
  })
}

export const computeAvailableToTransferPools = (
  tav: number | null,
  imr: number | null,
  assetBalances: Record<string, AssetBalance> | undefined,
) => {
  if (tav === null || imr === null || !assetBalances) {
    return null
  }

  return floorNumber(
    Math.max(0, Math.min(assetBalances[USDC_ASSET_ID]?.margin_balance ?? 0, tav - imr)),
    2,
  )
}

export const computeAvailableMarginForLimitOrders = (
  availableOrderMargin: number | null,
  assetBalances: Record<string, AssetBalance> | undefined,
  positionOrderMarginOffset: number | null,
  position: Position | undefined,
) => {
  if (availableOrderMargin === null || positionOrderMarginOffset === null || !assetBalances) {
    return null
  }

  if (position?.margin_mode === MarginMode.ISOLATED) {
    return floorNumber(
      positionOrderMarginOffset +
        Math.max(
          0,
          Math.min(
            availableOrderMargin,
            assetBalances[USDC_ASSET_ID]?.available_margin_balance ?? 0,
          ),
        ),
      2,
    )
  }

  return floorNumber(positionOrderMarginOffset + Math.max(0, availableOrderMargin), 2)
}

export const computeAvailableMarginForMarketOrders = (
  tav: number | null,
  imr: number | null,
  assetBalances: Record<string, AssetBalance> | undefined,
  positionMarginOffset: number | null,
  position: Position | undefined,
) => {
  if (tav === null || imr === null || positionMarginOffset === null || !assetBalances) {
    return null
  }

  // you can always trade your existing position if you're reducing it first
  if (position?.margin_mode === MarginMode.ISOLATED) {
    return floorNumber(
      positionMarginOffset +
        Math.max(0, Math.min(tav - imr, assetBalances[USDC_ASSET_ID]?.margin_balance ?? 0)),
      2,
    )
  }

  return floorNumber(positionMarginOffset + Math.max(0, tav - imr), 2)
}

export const computeAvailableToDemarginize = (
  tav: number | null,
  imr: number | null,
  indexPrice: number | undefined,
  assetBalance: AssetBalance | undefined,
  asset: AssetMeta,
) => {
  if (tav === null || imr === null || assetBalance === undefined || !indexPrice) {
    return null
  }

  return floorNumber(
    Math.max(
      0,
      Math.min(assetBalance.margin_balance, (tav - imr) / indexPrice / Number(asset.loan_to_value)),
    ),
    asset.size_decimals,
  )
}

// This can use the available to withdraw but with an extra floor as the market has less precision than the asset
export const computeSpotAvailableToTradeMarket = (
  asset: AssetMeta | undefined,
  assetBalances: Record<string, AssetBalance> | undefined,
  currentMarket: OrderBookDetail,
  indexPrice: number | undefined,
  isShort: boolean,
  tav: number | null,
  imr: number | null,
) => {
  if (!asset || !assetBalances) {
    return null
  }

  const decimals = isShort ? currentMarket.size_decimals : currentMarket.price_decimals
  const assetBalance = assetBalances[asset.asset_id]

  if (!assetBalance) {
    return 0
  }

  if (assetBalance.margin_mode === 'disabled') {
    return floorNumber(Math.max(0, assetBalance.balance), decimals)
  }

  if (tav === null || imr === null || !indexPrice) {
    return null
  }

  return floorNumber(
    assetBalance.balance +
      Math.max(
        0,
        Math.min(
          assetBalance.margin_balance,
          (tav - imr) / indexPrice / Number(asset.loan_to_value),
        ),
      ),
    decimals,
  )
}

export const computeSpotAvailableToTradeLimit = (
  asset: AssetMeta | undefined,
  assetBalances: Record<string, AssetBalance> | undefined,
  currentMarket: OrderBookDetail,
  indexPrice: number | undefined,
  isShort: boolean,
  availableOrderMargin: number | null,
) => {
  if (!asset || !assetBalances) {
    return null
  }

  const assetBalance = assetBalances[asset.asset_id]

  if (!assetBalance) {
    return 0
  }

  const decimals = isShort ? currentMarket.size_decimals : currentMarket.price_decimals

  if (assetBalance.margin_mode === 'disabled') {
    return floorNumber(assetBalance.available_balance, decimals)
  }

  if (availableOrderMargin === null || !indexPrice) {
    return null
  }

  const availablePerpsBalance = Math.max(
    0,
    Math.min(
      assetBalance.available_margin_balance,
      availableOrderMargin / indexPrice / Number(asset.loan_to_value),
    ),
  )

  return floorNumber(assetBalance.available_balance + availablePerpsBalance, decimals)
}
