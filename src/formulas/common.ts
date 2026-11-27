import {
  AccountBinaryOptionsPositionSignEnum,
  AccountPositionMarginModeEnum,
  AccountPositionSignEnum,
} from 'zklighter-perps'
import { FREE_ORDER_BATCH_SIZE, MARGIN_FRACTION_TICK, OrderDirections } from '../constants/shared'
import { errorReporting } from '../lib/errorReporting'
import { LLP_ASSET_ID, USDC_ASSET_ID } from '../store/orderbook/selectors'
import type { selectPerpsOrderBookMetas } from '../store/orderbook/metadataSelectors'
import type {
  selectPositionsClosePrices,
  selectPositionsMarkPrices,
} from '../store/selectors/common'
import type { AssetBalance, BOPosition, OrderbookItem, Position } from '../store/types'
import type { AssetMeta, PerpsOrderBookDetail } from '../types/compatibility'
import { floorNumber } from '../utils/precision'
import { type BOPositionPriceStats, getBOPositionPrice } from '../utils/bo'

import { computeWorstExecutionPrice, matchBaseAmount } from './orderBook'

export const marginFractionToPercentage = (marginFraction: number) =>
  marginFraction / MARGIN_FRACTION_TICK

export const marginFractionToLeverage = (marginFraction: number) =>
  MARGIN_FRACTION_TICK / marginFraction

export const leverageToMarginFraction = (leverage: number) =>
  Math.round(MARGIN_FRACTION_TICK / leverage)

export const computeMarginReq = (size: number, markPrice: number, marginFraction: number) =>
  size * markPrice * marginFractionToPercentage(marginFraction)

export const isLeverageChangeValid = (
  crossTotalAccountValue: number,
  crossInitialMarginRequirement: number,
  position: Position | undefined,
  markPrice: number,
  newInitialMarginFraction: number,
) => {
  if (!Number.isFinite(newInitialMarginFraction)) {
    return false
  }

  if (!position?.position || newInitialMarginFraction <= position.initial_margin_fraction) {
    return true
  }

  const availableMargin =
    position.margin_mode === AccountPositionMarginModeEnum.Cross
      ? crossTotalAccountValue - crossInitialMarginRequirement
      : position.allocated_margin +
        computePositionPnl(position, markPrice) -
        computeMarginReq(position.position, markPrice, position.initial_margin_fraction)

  const initialMarginRequirementDelta = computeMarginReq(
    position.position,
    markPrice,
    newInitialMarginFraction - position.initial_margin_fraction,
  )

  return initialMarginRequirementDelta <= availableMargin
}

export const computePositionPnl = (
  position: Pick<Position, 'position' | 'avg_entry_price' | 'sign'>,
  price: number,
) => position.position * (price - position.avg_entry_price) * position.sign

export const computeCollateralLockedInPosition = (
  size: number,
  avgPrice: number,
  marginFraction: number,
) => size * avgPrice * marginFractionToPercentage(marginFraction)

export const computePositionLeverage = (
  positionSize: number,
  markPrice: number,
  totalAccountValue: number,
) => {
  if (totalAccountValue <= 0) {
    return Infinity
  }

  return (positionSize * markPrice) / totalAccountValue
}

export const computeGainLoss = (unrealizedPnl: number, collateralUsed: number) =>
  unrealizedPnl / collateralUsed

export const computePositionGainLoss = (
  position: Pick<Position, 'position' | 'avg_entry_price' | 'sign' | 'initial_margin_fraction'>,
  markPrice: number,
) =>
  computeGainLoss(
    computePositionPnl(position, markPrice),
    computeCollateralLockedInPosition(
      position.position,
      position.avg_entry_price,
      position.initial_margin_fraction,
    ),
  )

// realize pnl on how much of the current position is being closed (but not more than current position)
export const computeRealizedPnl = (
  positionDelta: Pick<Position, 'position' | 'avg_entry_price' | 'sign'> | null,
  currentPosition?: Pick<Position, 'position' | 'avg_entry_price' | 'sign'>,
) => {
  if (!currentPosition || !positionDelta || currentPosition.sign === positionDelta.sign) {
    return 0
  }

  return computePositionPnl(
    { ...currentPosition, position: Math.min(positionDelta.position, currentPosition.position) },
    positionDelta.avg_entry_price,
  )
}

export const computeTotalAccountValue = (
  collateral: number | null,
  unrealizedPnl: number | null,
) => {
  if (collateral === null || unrealizedPnl === null) {
    return null
  }

  return floorNumber(collateral + unrealizedPnl, 2)
}

// Full-precision account value for liquidation calculations. Unlike
// computeTotalAccountValue, this must NOT floor: the liquidation price relies on
// the unrealized-PnL component to cancel the mark price, and flooring to cents
// freezes the account value for small positions (sub-cent per-tick PnL changes
// get rounded away), which makes the computed liquidation price drift ~1:1 with
// the mark price. Display/rounding is the caller's responsibility.
export const computeTotalAccountLiquidationValue = (
  collateral: number | null,
  unrealizedPnl: number | null,
) => {
  if (collateral === null || unrealizedPnl === null) {
    return null
  }

  return collateral + unrealizedPnl
}

export const computeLiqCollateral = (
  assetMetas: Record<string, Pick<AssetMeta, 'liquidation_threshold'>>,
  assetBalances: Record<string, Pick<AssetBalance, 'margin_balance'>> | undefined,
  indexPrices: Record<string, number>,
) => {
  if (!assetBalances) {
    return null
  }

  return Object.entries(assetBalances).reduce((acc, [assetId, { margin_balance }]) => {
    const assetMeta = assetMetas[assetId]

    if (!assetMeta) {
      errorReporting.captureException(new Error('Missing asset meta for asset balance'), {
        tags: { source: 'computeLiqCollateral', assetId },
      })
      return acc
    }

    return (
      acc + margin_balance * (indexPrices[assetId] ?? 0) * Number(assetMeta.liquidation_threshold)
    )
  }, 0)
}

export const computeCrossCollateral = (
  assetMetas: Record<string, Pick<AssetMeta, 'loan_to_value'>>,
  assetBalances: Record<string, Pick<AssetBalance, 'margin_balance'>> | undefined,
  indexPrices: Record<string, number>,
) => {
  if (!assetBalances) {
    return null
  }

  return Object.entries(assetBalances).reduce((acc, [assetId, { margin_balance }]) => {
    const assetMeta = assetMetas[assetId]

    if (!assetMeta) {
      errorReporting.captureException(new Error('Missing asset meta for asset balance'), {
        tags: { source: 'computeCrossCollateral', assetId },
      })
      return acc
    }

    return acc + margin_balance * (indexPrices[assetId] ?? 0) * Number(assetMeta.loan_to_value)
  }, 0)
}

export const computeTotalAllocatedMargin = (
  positions?: Record<string, Pick<Position, 'allocated_margin'>>,
) => {
  if (!positions) {
    return null
  }

  return Object.values(positions).reduce((acc, position) => position.allocated_margin + acc, 0)
}

export const computeCrossLeverage = (
  crossTotalAccountValue: number | null,
  markPrices: Record<string, number>,
  positions?: Record<string, Pick<Position, 'position'>>,
) => {
  if (!crossTotalAccountValue || !positions) {
    return null
  }

  return (
    Object.entries(positions).reduce(
      (acc, [marketId, position]) => acc + position.position * (markPrices[marketId] ?? 0),
      0,
    ) / crossTotalAccountValue
  )
}

export const computeMarginUsage = (totalAccountValue: number | null, marginReq: number | null) => {
  if (totalAccountValue === null || marginReq === null) {
    return null
  }

  if (marginReq === 0) {
    return 0
  }

  if (totalAccountValue <= -0.01) {
    return Infinity
  }

  const marginUsage = (marginReq / totalAccountValue) * 100

  return Number.isNaN(marginUsage) ? null : marginUsage
}

// computes liq price for 1 position
export const computePositionLiquidationPrice = (
  position: Pick<Position, 'position' | 'sign'>,
  markPrice: number,
  market: Pick<PerpsOrderBookDetail, 'maintenance_margin_fraction'>,
  totalAccountValue: number,
  maintenanceMarginReq: number,
) => {
  const liquidationPrice =
    markPrice +
    (totalAccountValue - maintenanceMarginReq) /
      (position.position *
        (marginFractionToPercentage(market.maintenance_margin_fraction) - position.sign))

  if (isNaN(liquidationPrice) || !isFinite(liquidationPrice) || liquidationPrice < 0) {
    return null
  }

  if (
    (position.sign === AccountPositionSignEnum.Long && liquidationPrice >= markPrice) ||
    (position.sign === AccountPositionSignEnum.Short && liquidationPrice <= markPrice)
  ) {
    return markPrice
  }

  return liquidationPrice
}

// computes liq prices for all opened positions, does only the wiring
export const computePositionsLiqPrices = (
  markPrices: Record<string, number>,
  perpsOrderBookMetas: Record<string, Pick<PerpsOrderBookDetail, 'maintenance_margin_fraction'>>,
  crossMaintenanceMarginReq: number | null,
  crossTotalAccountValue: number | null,
  positions?: Record<string, Position>,
) => {
  if (!positions || crossTotalAccountValue === null || crossMaintenanceMarginReq === null) {
    return {}
  }

  return Object.values(positions)
    .filter((position) => position.position !== 0)
    .reduce(
      (acc, position) => {
        const market = perpsOrderBookMetas[position.market_id]
        const markPrice = markPrices[position.market_id]

        if (!market) {
          errorReporting.captureException(
            new Error('Missing perps order book meta for market with open position'),
            { tags: { source: 'computePositionsLiqPrices', marketId: String(position.market_id) } },
          )
          return acc
        }

        if (!markPrice) {
          return acc
        }

        const liqPrice =
          position.margin_mode === AccountPositionMarginModeEnum.Cross
            ? computePositionLiquidationPrice(
                position,
                markPrice,
                market,
                crossTotalAccountValue,
                crossMaintenanceMarginReq,
              )
            : computePositionLiquidationPrice(
                position,
                markPrice,
                market,
                position.allocated_margin + computePositionPnl(position, markPrice),
                computeMarginReq(position.position, markPrice, market.maintenance_margin_fraction),
              )

        if (liqPrice === null) {
          return acc
        }

        acc[position.market_id] = liqPrice

        return acc
      },
      {} as Record<string, number>,
    )
}

export const computeTotalMaintenanceMarginReq = (
  markPrices: Record<string, number>,
  perpsOrderBookMetas: Record<string, Pick<PerpsOrderBookDetail, 'maintenance_margin_fraction'>>,
  positions?: Record<string, Pick<Position, 'position'>>,
) => {
  if (!positions) {
    return null
  }

  return Object.entries(positions).reduce((acc, [marketId, position]) => {
    if (position.position === 0) {
      return acc
    }

    const meta = perpsOrderBookMetas[marketId]

    if (!meta) {
      errorReporting.captureException(
        new Error('Missing perps order book meta for market with open position'),
        { tags: { source: 'computeTotalMaintenanceMarginReq', marketId } },
      )
      return acc
    }

    return (
      acc +
      computeMarginReq(
        position.position,
        markPrices[marketId] ?? 0,
        meta.maintenance_margin_fraction,
      )
    )
  }, 0)
}

export const computeInitialMarginReq = (
  markPrices: Record<string, number>,
  positions?: Record<string, Pick<Position, 'position' | 'initial_margin_fraction'>>,
) => {
  if (!positions) {
    return null
  }

  return Object.entries(positions).reduce(
    (acc, [marketId, position]) =>
      acc +
      computeMarginReq(
        position.position,
        markPrices[marketId] ?? 0,
        position.initial_margin_fraction,
      ),
    0,
  )
}

export const computeSpotEquity = (
  indexPrices: Record<string, number>,
  assetBalances?: Record<string, Pick<AssetBalance, 'asset_id' | 'balance' | 'margin_balance'>>,
) => {
  if (!assetBalances) {
    return null
  }

  return Object.values(assetBalances).reduce((acc, { asset_id, balance, margin_balance }) => {
    if (asset_id === LLP_ASSET_ID) {
      return acc
    }

    return (
      acc +
      (balance + (asset_id === USDC_ASSET_ID ? 0 : margin_balance)) * (indexPrices[asset_id] ?? 0)
    )
  }, 0)
}

// The balances computeSpotEquity prices; spot equity is unknown until each has an index price
export const hasSpotIndexPrices = (
  indexPrices: Record<string, number>,
  assetBalances: Pick<AssetBalance, 'asset_id' | 'balance' | 'margin_balance'>[],
) =>
  assetBalances.every(
    ({ asset_id, balance, margin_balance }) =>
      asset_id === LLP_ASSET_ID ||
      balance + (asset_id === USDC_ASSET_ID ? 0 : margin_balance) === 0 ||
      indexPrices[asset_id] !== undefined,
  )

export const computeBOEquity = (
  marketsStats: Record<string, BOPositionPriceStats>,
  positions?: Record<string, Pick<BOPosition, 'sign' | 'size' | 'avg_entry_price'>>,
) => {
  if (!positions) {
    return null
  }

  return Object.entries(positions).reduce((equity, [marketId, position]) => {
    const direction =
      position.sign === AccountBinaryOptionsPositionSignEnum.Yes
        ? OrderDirections.Long
        : OrderDirections.Short
    const positionPrice = getBOPositionPrice(
      direction,
      position.avg_entry_price,
      marketsStats[marketId],
    )
    return positionPrice === null ? equity : equity + position.size * positionPrice
  }, 0)
}

export const computePerpsEquity = (
  allocatedMargin: number | null,
  unrealizedPnl: number | null,
  assetBalances: Record<string, AssetBalance> | undefined,
) => {
  if (allocatedMargin === null || unrealizedPnl === null || !assetBalances) {
    return null
  }

  return floorNumber(
    allocatedMargin + (assetBalances[USDC_ASSET_ID]?.margin_balance ?? 0) + unrealizedPnl,
    2,
  )
}

export const computeTotalUnrealizedPnl = (
  markPrices: Record<string, number>,
  positions?: Record<string, Pick<Position, 'position' | 'avg_entry_price' | 'sign'>>,
) => {
  if (!positions) {
    return null
  }

  return Object.entries(positions).reduce((pnl, [marketId, position]) => {
    const markPrice = markPrices[marketId]

    if (markPrice === undefined) {
      return pnl
    }

    return pnl + computePositionPnl(position, markPrice)
  }, 0)
}

export const getPositionPnlPrice = <TMarkPrice extends number | undefined>({
  markPrice,
  midPrice,
  isRwaMarket,
}: {
  markPrice: TMarkPrice
  midPrice: number | undefined
  isRwaMarket: boolean
}) => (isRwaMarket && midPrice ? midPrice : markPrice)

export const computeDisplayTotalUnrealizedPnl = (
  markPrices: Record<string, number>,
  midPrices: Record<string, number>,
  positions: Record<string, Pick<Position, 'position' | 'avg_entry_price' | 'sign'>> | undefined,
  perpsOrderBookMetas: Record<string, Pick<PerpsOrderBookDetail, 'backend_symbol'>>,
  rwaCoins: Set<string>,
) => {
  if (!positions) {
    return null
  }

  return Object.entries(positions).reduce((pnl, [marketId, position]) => {
    const market = perpsOrderBookMetas[marketId]
    const isRwaMarket = market ? rwaCoins.has(market.backend_symbol) : false
    const referencePrice = getPositionPnlPrice({
      markPrice: markPrices[marketId],
      midPrice: midPrices[marketId],
      isRwaMarket,
    })

    if (referencePrice === undefined) {
      return pnl
    }

    return pnl + computePositionPnl(position, referencePrice)
  }, 0)
}

export const computeEstPositionClosePnl = (
  currentMarket: PerpsOrderBookDetail | undefined,
  orders: OrderbookItem[],
  position: Position | undefined,
  estPrice: number,
  baseAmount: number,
) => {
  if (!currentMarket || !position) {
    return null
  }

  return Math.max(
    // position close can be market or limit for limit, we need to take the maximum value between if the order executed at limit price or at current price to account for both the case where it goes in the orderbook or it gets filled immediately
    computePositionPnl({ ...position, position: baseAmount }, estPrice),
    computePositionPnl(
      { ...position, position: baseAmount },
      matchBaseAmount(currentMarket, baseAmount, orders).estPrice,
    ),
  )
}

export const isLimitOrderUnsafe = (
  isShort: boolean,
  price: number,
  fairPrice: number,
  bestPrice: number,
) =>
  isShort
    ? 0.95 * Math.max(fairPrice, bestPrice) > price
    : 1.05 * Math.min(fairPrice, bestPrice || Infinity) < price

export const computeIsPriceFarFromFairPrice = (
  isShort: boolean,
  price: number,
  fairPrice: number | null,
  bestPrice: number,
) =>
  fairPrice !== null && bestPrice !== 0 && isLimitOrderUnsafe(isShort, price, fairPrice, bestPrice)

export const computeIsFairPriceMissing = (fairPrice: number | null, bestPrice: number) =>
  bestPrice > 0 && fairPrice === null

export const computeCloseAllPositionPrice = (
  isLong: boolean,
  maxSlippage: number,
  closePrice: number | undefined,
  markPrice: number | null,
) => {
  const referencePrice = closePrice || markPrice
  if (!referencePrice) {
    return null
  }

  const fairPrice = markPrice || null
  const price = computeWorstExecutionPrice(maxSlippage, isLong, referencePrice)

  return {
    price,
    isFarFromMarkPrice: computeIsPriceFarFromFairPrice(isLong, price, fairPrice, referencePrice),
    isMarkPriceMissing: computeIsFairPriceMissing(fairPrice, referencePrice),
  }
}

export const computeCloseAllPositionsPriceWarnings = ({
  positions,
  isStandardTier,
  maxSlippage,
  closePrices,
  markPrices,
  markets,
}: {
  positions: Record<string, Position>
  isStandardTier: boolean
  maxSlippage: number
  closePrices: ReturnType<typeof selectPositionsClosePrices>
  markPrices: ReturnType<typeof selectPositionsMarkPrices>
  markets: ReturnType<typeof selectPerpsOrderBookMetas>
}): { farFromMarkSymbols: string; markPriceMissingSymbols: string } => {
  const sortedPositions = Object.values(positions)
  const sentPositions = isStandardTier
    ? sortedPositions.slice(0, FREE_ORDER_BATCH_SIZE)
    : sortedPositions
  const farFromMark: string[] = []
  const markMissing: string[] = []
  for (const position of sentPositions) {
    const symbol = markets[position.market_id]?.symbol
    const closePrice = computeCloseAllPositionPrice(
      position.sign === AccountPositionSignEnum.Long,
      maxSlippage,
      closePrices[position.market_id],
      markPrices[position.market_id] ?? null,
    )
    if (!symbol || !closePrice) continue
    if (closePrice.isFarFromMarkPrice) farFromMark.push(symbol)
    if (closePrice.isMarkPriceMissing) markMissing.push(symbol)
  }
  return {
    farFromMarkSymbols: farFromMark.join(', '),
    markPriceMissingSymbols: markMissing.join(', '),
  }
}

const FLOAT_PRICE_TOLERANCE = 1e-9

export const isTriggerLimitPriceUnsafe = (
  isShort: boolean,
  limitPrice: number,
  triggerPrice: number,
) => {
  if (!limitPrice || !triggerPrice) {
    return false
  }

  const bound = computeWorstExecutionPrice(5, isShort, triggerPrice)

  return isShort
    ? limitPrice < bound * (1 - FLOAT_PRICE_TOLERANCE)
    : limitPrice > bound * (1 + FLOAT_PRICE_TOLERANCE)
}
