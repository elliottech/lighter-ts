import type { TimeInForce } from '../store/place-order/utils'
import type { FeePercentages } from '../store/selectors/fees'
import type { OrderbookItem, Position } from '../store/types'
import type { OrderBookDetail } from '../types/compatibility'
import { MarginMode } from '../types/MarginMode'
import { OrderType } from '../types/order'
import type { ExtendedUserTier } from '../types/user-tiers'
import { getFeePercentageFromTier, isMarketSpot } from '../utils/common'
import { floorNumber } from '../utils/precision'

import { computeMarginReq, marginFractionToLeverage } from './common'
import { matchQuoteAmount } from './orderBook'

// what we expect the resulting position to be if the user were to place the order with the current state of the inputs
const combinePositions = (position: Position, positionDelta: Position): Position => {
  const oldPositionSize = position.position * position.sign
  const positionDeltaSize = positionDelta.position * positionDelta.sign
  const combinedPositionSize = oldPositionSize + positionDeltaSize
  let avgEntryPrice = 0

  if (combinedPositionSize === 0) {
    return { ...position, position: 0, avg_entry_price: 0, allocated_margin: 0 }
  }

  if (position.sign !== positionDelta.sign) {
    avgEntryPrice =
      Math.sign(combinedPositionSize) === position.sign
        ? position.avg_entry_price
        : positionDelta.avg_entry_price
  } else {
    const oldPositionValue = oldPositionSize * position.avg_entry_price
    const positionDeltaValue = positionDeltaSize * positionDelta.avg_entry_price
    const combinedPositionValue = oldPositionValue + positionDeltaValue

    avgEntryPrice = combinedPositionValue / combinedPositionSize
  }

  let allocatedMargin = 0
  if (position.margin_mode === MarginMode.ISOLATED) {
    if (position.sign === positionDelta.sign) {
      allocatedMargin = position.allocated_margin + positionDelta.allocated_margin
    } else {
      if (positionDelta.position < position.position) {
        allocatedMargin =
          position.allocated_margin * (1 - positionDelta.position / position.position)
      } else {
        allocatedMargin =
          positionDelta.allocated_margin * (1 - position.position / positionDelta.position)
      }
    }
  }

  return {
    ...position,
    sign: Math.sign(combinedPositionSize),
    position: Math.abs(combinedPositionSize),
    avg_entry_price: avgEntryPrice,
    allocated_margin: allocatedMargin,
  }
}

export const computePositionDelta = (
  currentMarketPosition: Position | undefined,
  initialMarginFraction: number,
  currentMarket: Pick<OrderBookDetail, 'market_id' | 'market_type'>,
  isShort: boolean,
  baseAmount: number,
  estPrice: number,
): Position | null => {
  if (baseAmount === 0 || isMarketSpot(currentMarket)) {
    return null
  }

  const marginMode = currentMarketPosition?.margin_mode ?? MarginMode.CROSS

  return {
    market_id: currentMarket.market_id,
    initial_margin_fraction: initialMarginFraction,
    sign: isShort ? -1 : 1,
    total_funding_paid_out: 0,
    total_discount: 0,
    margin_mode: marginMode,
    position: baseAmount,
    avg_entry_price: estPrice,
    allocated_margin:
      marginMode === MarginMode.CROSS
        ? 0
        : computeMarginReq(baseAmount, estPrice, initialMarginFraction),
    // TODO: check if this is correct or if we even care about this
    margin_set_flag: currentMarketPosition?.margin_set_flag ?? 0,
  }
}

export const computeUpdatedPositions = (
  positions: Record<string, Position> = {},
  positionDelta: Position | null,
  currentMarketId: number,
): Record<string, Position> => {
  const previousPosition = positions?.[currentMarketId]

  if (!positionDelta) {
    return positions
  }

  if (!previousPosition?.position) {
    return { ...positions, [currentMarketId]: positionDelta }
  }

  return { ...positions, [currentMarketId]: combinePositions(previousPosition, positionDelta) }
}

// computes what the resulting cross collateral is assuming the user were
// to place the order with the current state of the inputs based
// on how much collateral we expect to be moved to/from an isolated position
export const computeUpdatedCrossCollateral = (
  crossCollateral: number | null,
  realizedPnl: number,
  markPrice: number | null,
  positionDelta: Position | null, // this is the estimated position if there was no current position
  fees: Pick<FeePercentages, 'takerFee'>,
  position?: Position,
) => {
  if (crossCollateral === null || !markPrice) {
    return null
  }

  if (!positionDelta) {
    return crossCollateral
  }

  const takerFee = fees.takerFee * positionDelta.position * positionDelta.avg_entry_price

  if (positionDelta.margin_mode === MarginMode.CROSS) {
    return crossCollateral + realizedPnl - takerFee
  }

  // increasing position, fees are paid from cross collateral
  if (!position?.position || position.sign === positionDelta.sign) {
    return crossCollateral - positionDelta.allocated_margin - takerFee
  }

  // reversing position, fees are paid from cross collateral
  if (positionDelta.position >= position.position) {
    return (
      crossCollateral +
      realizedPnl +
      position.allocated_margin -
      positionDelta.allocated_margin * (1 - position.position / positionDelta.position) -
      takerFee
    )
  }

  // in isolated reduce position, fee is first taken from extra margin of isolated position
  const combinedPosition = combinePositions(position, positionDelta)

  const extraMargin =
    combinedPosition.allocated_margin -
    computeMarginReq(combinedPosition.position, markPrice, combinedPosition.initial_margin_fraction)

  return (
    crossCollateral +
    realizedPnl +
    position.allocated_margin * (positionDelta.position / position.position) -
    Math.max(0, takerFee - extraMargin)
  )
}

const getMaxReduceOnlyValue = (position: Position | undefined, isShort: boolean) => {
  if (!position || (position.sign === -1) === isShort) {
    return 0
  }

  return position.position
}

// When decreasing position, we need to see how much availableToTrade we gain

// CROSS
// realizedPnl = size * sign * (markPrice - OBPrice)
// freedIMR = size * markPrice / leverage
// fees = size * takerFee * OBPrice
// newAvailableToTrade = availableToTrade + freedIMR + realizedPnl - fees
// newAvailableToTrade = availableToTrade + size * (markPrice / leverage) + size * sign * (markPrice - OBPrice) - size * takerFee * OBPrice
// newAvaialbleToTrade = availableToTrade + size * (markPrice / leverage + sign * (markPrice - OBPrice) - takerFee * OBPrice)

// ISOLATED
// normally fees are more complicated to check because sometimes they come from remaining isolated margin
// but in this case we care about what happens after we fully close the isolated position
// newAvailableToTrade = availableToTrade + allocated_margin + realizedPnl - fees
// newAvaialbleToTrade = availableToTrade + allocated_margin + size * (sign * (markPrice - OBPrice) - takerFee * OBPrice)

// Formula for largest order size an account can fill at a given OBPrice and how we got to it

// availableToTrade = TAV - IMR
// newPnl = size * sign * (markPrice - OBPrice)
// newIMR = size * markPrice / leverage
// fees = size * takerFee * OBPrice
// newAvailableToTrade > 0
// newAvailableToTrade = availableToTrade - newIMR + newPnl - fees
// availableToTrade - newIMR + newPnl - fees > 0
// availableToTrade - size * markPrice / leverage + size * sign * (markPrice - OBPrice) - size * takerFee * OBPrice > 0
// availableToTrade > size * markPrice / leverage - size * sign * (markPrice - OBPrice) + size * takerFee * OBPrice
// availableToTrade > size * (markPrice / leverage - sign * (markPrice - OBPrice) + takerFee * OBPrice)
// availableToTrade / (markPrice / leverage - sign * (markPrice - OBPrice) + takerFee * OBPrice) > size
// size < availableToTrade / (markPrice / leverage - sign * (markPrice - OBPrice) + takerFee * OBPrice)

// we have formulas assuming we can fill the entire order at a single price
// because it's not guaranteed that there is enough liquidity at a given price to fill the entire order
// we need to take each order in the orderBook, see if it's enough to fill it and if it's not,
// we run the computations using the available size and then we update the params and run it again
// untill either liquidity runs out or there's not enough margin

export const getMaxMatchableBaseAmount = (
  userTier: ExtendedUserTier,
  market: Pick<OrderBookDetail, 'size_decimals'>,
  markPrice: number,
  orders: OrderbookItem[],
  initialMarginFraction: number,
  availableToTrade: number,
  isShort: boolean,
  feeTicks: { takerFeeTick: number; makerFeeTick: number } | null,
) => {
  const { taker: takerFee } = getFeePercentageFromTier(userTier ?? 'standard', feeTicks)
  const leverage = marginFractionToLeverage(initialMarginFraction)
  let currentOrderIndex = 0
  let currentClonedOrderPrice = orders[currentOrderIndex]?.price
  let currentClonedOrderSize = orders[currentOrderIndex]?.size
  currentOrderIndex++
  let matchedSize = 0
  let availableToTradeLeft = availableToTrade

  while (currentClonedOrderPrice !== undefined && currentClonedOrderSize !== undefined) {
    const sign = isShort ? -1 : 1
    const OBPrice = currentClonedOrderPrice
    // this isn't really a price but we use it to divide a $ amount to get a size
    const adjustedPrice = markPrice / leverage - sign * (markPrice - OBPrice) + takerFee * OBPrice
    // In integration tests, mark price could be 32k and OB price is 2800 which makes no sense, but in this case it would make this value negative
    // In that case the maxSize is basically infinity
    const maxSizeForThisPrice = adjustedPrice <= 0 ? Infinity : availableToTradeLeft / adjustedPrice
    const matchedOrderSize = Math.min(currentClonedOrderSize, maxSizeForThisPrice)

    const imr = computeMarginReq(matchedOrderSize, markPrice, initialMarginFraction)
    const unrealizedPnl = matchedOrderSize * sign * (markPrice - OBPrice)
    const fees = matchedOrderSize * takerFee * OBPrice

    matchedSize += matchedOrderSize
    availableToTradeLeft -= imr
    availableToTradeLeft += unrealizedPnl
    availableToTradeLeft -= fees

    if (matchedOrderSize === maxSizeForThisPrice) {
      break
    }
    currentClonedOrderPrice = orders[currentOrderIndex]?.price
    currentClonedOrderSize = orders[currentOrderIndex]?.size
    currentOrderIndex++
  }

  // all the OB can be matched
  if (currentOrderIndex >= orders.length && currentClonedOrderSize === undefined) {
    return null
  }
  return floorNumber(matchedSize, market.size_decimals)
}

export const computePerpsSliderMaxBaseAmount = (
  userTier: ExtendedUserTier,
  currentMarket: OrderBookDetail,
  reduceOnly: boolean,
  availableLiquidity: number,
  orderBookOrders: OrderbookItem[],
  markPrice: number | null,
  initialMarginFraction: number,
  position: Position | undefined,
  orderType: OrderType,
  isShort: boolean,
  availableMarginForMarketOrders: number | null,
  availableMarginBaseAmount: number | null,
  feeTicks: { takerFeeTick: number; makerFeeTick: number } | null,
  timeInForce: TimeInForce,
) => {
  if (availableMarginForMarketOrders === null || !markPrice || availableMarginBaseAmount === null) {
    return 0
  }

  const maxReduceOnlyValue = getMaxReduceOnlyValue(position, isShort)

  if (reduceOnly) {
    if ((orderType === OrderType.Limit || orderType === OrderType.Scale) && timeInForce !== 'ioc') {
      return Math.min(maxReduceOnlyValue, availableMarginBaseAmount * 0.99)
    }

    return maxReduceOnlyValue
  }

  // these never get immediately filled so we don't need to estimate fill impact to IMR < TAV
  if (orderType === OrderType.Conditional || orderType === OrderType.Twap) {
    return availableMarginBaseAmount * 0.99
  }

  const maxMatchableBaseAmount = getMaxMatchableBaseAmount(
    userTier,
    currentMarket,
    markPrice,
    orderBookOrders,
    initialMarginFraction,
    availableMarginForMarketOrders,
    isShort,
    feeTicks,
  )

  if (orderType === OrderType.Market) {
    if (maxMatchableBaseAmount === null) {
      return availableLiquidity
    }

    return Math.max(maxReduceOnlyValue, maxMatchableBaseAmount * 0.99)
  }

  // for limit orders, we don't care that we can't match all of it because of liquidity as the rest of it goes in the orderbook
  // we only care about the matching if there is enough liquidity and the order would fail with "not enough margin"
  if (maxMatchableBaseAmount === null) {
    return availableMarginBaseAmount * 0.99
  }

  // when going long, order margin is always more restrictive
  return (
    (isShort
      ? Math.min(maxMatchableBaseAmount, availableMarginBaseAmount)
      : availableMarginBaseAmount) * 0.99
  )
}

export const computeSpotSliderMaxBaseAmount = (
  currentMarket: OrderBookDetail,
  availableLiquidity: number,
  orderBookOrders: OrderbookItem[],
  orderType: OrderType,
  isShort: boolean,
  availableToTradeMarket: number | null,
  availableToTradeLimit: number | null,
  conversionPrice: number,
  canPlaceLimitOrderFullAmount: boolean,
) => {
  if (availableToTradeMarket === null || availableToTradeLimit === null) {
    return 0
  }

  if (isShort) {
    switch (orderType) {
      case OrderType.Market:
        return Math.min(availableToTradeMarket, availableLiquidity)
      case OrderType.Limit:
      case OrderType.Scale:
      case OrderType.Twap:
        return availableToTradeLimit
      default:
        return 0 as never
    }
  }

  switch (orderType) {
    case OrderType.Market: {
      const maxMatchableBaseAmount = matchQuoteAmount(
        currentMarket,
        availableToTradeMarket,
        orderBookOrders,
      ).baseAmount

      if (availableLiquidity === maxMatchableBaseAmount) {
        return availableLiquidity
      }

      return maxMatchableBaseAmount * 0.995
    }
    case OrderType.Limit:
    case OrderType.Scale:
    case OrderType.Twap: {
      if (canPlaceLimitOrderFullAmount) {
        return availableToTradeLimit / conversionPrice
      }

      return (availableToTradeLimit / conversionPrice) * 0.995
    }
    default:
      return 0 as never
  }
}
