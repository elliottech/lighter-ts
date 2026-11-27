import { getUnixTime } from 'date-fns'
import type { TFunction } from 'i18next'
import {
  BinaryOptionMarketStatsOutcomeEnum,
  BinaryOptionMarketStatsStatusEnum,
  type EventDetail,
  type EventOrderBookEntry,
  TradeTypeEnum,
} from 'zklighter-perps'

import { OrderDirections } from '../constants/shared'
import type { BOSide } from '../store/bo/createBOSlice'
import type { WsBOMarketStats, WsBOPosition, WsOrder, WsTrade } from '../lighter-ws/types/WsMessage'
import { sanitizeNumberInput } from './common'
import { getOrderAveragePrice } from './getOrderAveragePrice'
import { floorNumber, roundNumber } from './precision'

export const BO_SETTLEMENT_VALUE = 1.0
export const BO_PRICE_DECIMALS = 2
export const BO_SIZE_DECIMALS = 4
const BO_QUOTE_DECIMALS = 6
export const BO_LIMIT_PRICE_INPUT_DECIMALS = BO_PRICE_DECIMALS - 2
export const BO_ORDER_SIZE_PRESETS = [10, 25, 50, 100] as const
export const BO_ORDER_NOTIONAL_PRESETS = [10, 25, 50, 100] as const
export const BO_DEFAULT_ORDER_NOTIONAL = 25
export const BO_DEFAULT_PRICE_TOLERANCE_CENTS = 2
export const BO_MAX_PRICE_TOLERANCE_CENTS = 10
export const BO_FEE_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
  roundingMode: 'halfExpand',
}

// TODO: read the resolution source from the event once the backend exposes it
export const BO_UP_DOWN_RESOLUTION_SOURCE = 'Chainlink 60s TWAP'

export const flipBOPrice = (price: number): number => roundNumber(1 - price, BO_PRICE_DECIMALS)

// An empty book reports a mid of 0, which is never a tradeable price.
export const getBOStatsMidPrice = (
  stats: Pick<WsBOMarketStats, 'mid_price'> | undefined,
): number | null => (stats !== undefined && stats.mid_price > 0 ? stats.mid_price : null)

export const getBOSidePrice = (upPrice: number, direction: OrderDirections): number =>
  direction === OrderDirections.Long ? upPrice : flipBOPrice(upPrice)

const toBOTicks = (price: number): number => Math.round(price * 10 ** BO_PRICE_DECIMALS)

export const getBOLimitMidPrice = (
  stats: Pick<WsBOMarketStats, 'mid_price' | 'best_bid_price' | 'best_ask_price'> | undefined,
  direction: OrderDirections,
): number | null => {
  if (stats === undefined) return null
  if (stats.best_bid_price > 0 && stats.best_ask_price > 0) {
    const bid = getBOSidePrice(
      direction === OrderDirections.Long ? stats.best_bid_price : stats.best_ask_price,
      direction,
    )
    const ask = getBOSidePrice(
      direction === OrderDirections.Long ? stats.best_ask_price : stats.best_bid_price,
      direction,
    )
    return Math.floor((toBOTicks(bid) + toBOTicks(ask)) / 2) / 10 ** BO_PRICE_DECIMALS
  }
  const mid = getBOStatsMidPrice(stats)
  return mid === null ? null : getBOSidePrice(mid, direction)
}

export const getBOFilledPrice = (
  order: Pick<WsOrder, 'is_ask' | 'filled_base_amount' | 'filled_quote_amount'>,
): number | null => {
  const price = getOrderAveragePrice(order)
  if (price === null) return null
  return order.is_ask ? flipBOPrice(price) : price
}

export const getBOSidedOrderBook = <T extends { price: number }>(
  book: { asks: T[]; bids: T[] },
  direction: OrderDirections,
): { asks: T[]; bids: T[] } => {
  if (direction === OrderDirections.Long) return book
  const flip = (level: T): T => ({ ...level, price: flipBOPrice(level.price) })
  return { asks: book.bids.map(flip), bids: book.asks.map(flip) }
}

export const toBOLimitPriceInputValue = (price: number): string =>
  (price * 100).toFixed(BO_LIMIT_PRICE_INPUT_DECIMALS)

const BO_PRICE_TICK = 10 ** -BO_PRICE_DECIMALS

// The input is in cents; a limit price is one tick to one tick below the settlement value.
export const sanitizeBOLimitPriceInput = (rawValue: string): string | null => {
  const sanitized = sanitizeNumberInput(rawValue, BO_LIMIT_PRICE_INPUT_DECIMALS)
  if (sanitized === null || sanitized === '') return sanitized
  const price = roundNumber(Number(sanitized) / 100, BO_PRICE_DECIMALS)
  return price >= BO_PRICE_TICK &&
    price <= roundNumber(BO_SETTLEMENT_VALUE - BO_PRICE_TICK, BO_PRICE_DECIMALS)
    ? sanitized
    : null
}

type BOMarketPhase = 'upcoming' | 'active' | 'past'

export const isBOSettled = (stats: Pick<WsBOMarketStats, 'status'> | undefined): boolean | null =>
  stats === undefined ? null : stats.status === BinaryOptionMarketStatsStatusEnum.Settled

export const getBOEventSlug = (event: Pick<EventDetail, 'tag' | 'start_at'>): string =>
  `${event.tag}-${getUnixTime(event.start_at)}`

export interface BOMarketSymbolInfo {
  symbol: string
  slug: string
  occurrenceStartAt: number
  occurrenceEndAt: number
}

const BO_MARKET_SYMBOL_PATTERN = /^([A-Z0-9]+)-UPDOWN-(\d+)([SMH])-(\d+)$/
const BO_MARKET_SYMBOL_UNIT_SECONDS: Record<string, number> = { S: 1, M: 60, H: 3_600 }

export const parseBOMarketSymbol = (marketSymbol: string): BOMarketSymbolInfo | undefined => {
  const match = BO_MARKET_SYMBOL_PATTERN.exec(marketSymbol)
  if (match === null) return undefined

  const [, symbol = '', amount = '', unit = '', start = ''] = match
  const unitSeconds = BO_MARKET_SYMBOL_UNIT_SECONDS[unit] ?? 0
  const occurrenceStartAt = Number(start) * 1_000

  return {
    symbol,
    slug: marketSymbol.toLowerCase(),
    occurrenceStartAt,
    occurrenceEndAt: occurrenceStartAt + Number(amount) * unitSeconds * 1_000,
  }
}

export const getBOEventSymbol = (event: Pick<EventDetail, 'metadata'>): string | undefined => {
  const { type, symbol } = event.metadata
  return type === 'updown' && typeof symbol === 'string' ? symbol.toUpperCase() : undefined
}

export const isBOUpDownEvent = (event: Pick<EventDetail, 'metadata'>): boolean =>
  getBOEventSymbol(event) !== undefined

const parseBOFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const price = Number(value)
  return Number.isFinite(price) ? price : null
}

export const getBOEventStartPrice = (event: Pick<EventDetail, 'metadata'>): number | null =>
  parseBOFiniteNumber(event.metadata.start_price)

export const getBOEventSettlementPrice = (event: Pick<EventDetail, 'metadata'>): number | null =>
  parseBOFiniteNumber(event.metadata.settlement_price)

/** Resolved start and settlement prices of a series' settled windows, by unix second. */
export const getBOEventBoundaryPrices = (
  events: readonly EventDetail[],
  tag: string,
): Map<number, number> => {
  const prices = new Map<number, number>()
  for (const event of events) {
    if (event.tag !== tag) continue
    const startPrice = getBOEventStartPrice(event)
    const settlementPrice = getBOEventSettlementPrice(event)
    if (startPrice !== null) prices.set(Math.floor(event.start_at / 1_000), startPrice)
    if (settlementPrice !== null) prices.set(Math.floor(event.end_at / 1_000), settlementPrice)
  }
  return prices
}

export const getBOEventMarketId = (event: Pick<EventDetail, 'order_books'>): number | undefined =>
  event.order_books[0]?.market_id

export const getBOEventDurationMs = (event: Pick<EventDetail, 'start_at' | 'end_at'>) =>
  event.end_at - event.start_at

// The market accepts orders from its own start_timestamp, which the operator sets ahead of the
// price window (0 means from creation); the event's start_at is only the window start.
export const getBOEventOpensAt = (event: Pick<EventDetail, 'start_at' | 'order_books'>): number =>
  event.order_books[0]?.start_timestamp ?? event.start_at

export const getBORemainingSeconds = (endMs: number, now: number): number =>
  Math.max(0, Math.ceil((endMs - now) / 1000))

export const getBOLiveOccurrenceStart = (
  event: Pick<EventDetail, 'start_at' | 'end_at'>,
  now: number,
): number => {
  const durationMs = getBOEventDurationMs(event)
  return event.start_at + Math.floor((now - event.start_at) / durationMs) * durationMs
}

export const getBONextStartAt = (events: Pick<EventDetail, 'start_at'>[], now: number): number =>
  events.reduce(
    (next, event) =>
      event.start_at > now && (next === 0 || event.start_at < next) ? event.start_at : next,
    0,
  )

export const getBOAssetGroupClosestEvent = <T extends Pick<EventDetail, 'start_at' | 'end_at'>>(
  events: [T, ...T[]],
  now: number,
): T => {
  const [first, ...rest] = events.filter((event) => event.start_at <= now && event.end_at > now)
  if (first === undefined) return getBOAssetGroupChartEvent(events, now)
  return rest.reduce((closest, event) => (event.end_at < closest.end_at ? event : closest), first)
}

export const getBOAssetGroupChartEvent = <T extends Pick<EventDetail, 'start_at' | 'end_at'>>(
  events: [T, ...T[]],
  now: number,
): T => {
  const started = events.filter((event) => event.start_at <= now)
  const [first, ...rest] = started.length > 0 ? started : events
  return rest.reduce(
    (longest, event) =>
      getBOEventDurationMs(event) > getBOEventDurationMs(longest) ? event : longest,
    first ?? events[0],
  )
}

export const getBOEventPhase = (
  event: Pick<EventDetail, 'start_at' | 'end_at' | 'order_books'>,
  now: number,
): BOMarketPhase => {
  if (now < getBOEventOpensAt(event)) return 'upcoming'
  if (now < event.end_at) return 'active'
  return 'past'
}

// The market's default price, which a refund settles every share at on both sides.
// TODO: read the refund price from the market (its DefaultPrice) once the stats expose it; 50¢ holds for up/down markets.
const BO_REFUND_PRICE = BO_SETTLEMENT_VALUE / 2

// Settlement sets the outcome and the in-settlement status together; a refund settles at the default price,
// which leaves the outcome None.
export const isBORefunded = (
  stats: Pick<WsBOMarketStats, 'outcome' | 'status'> | undefined,
): boolean =>
  (stats?.status === BinaryOptionMarketStatsStatusEnum.InSettlement ||
    stats?.status === BinaryOptionMarketStatsStatusEnum.Settled) &&
  stats.outcome === BinaryOptionMarketStatsOutcomeEnum.None

export const getBOSettledDirection = (
  stats: Pick<WsBOMarketStats, 'outcome'> | undefined,
): OrderDirections | null => {
  switch (stats?.outcome) {
    case BinaryOptionMarketStatsOutcomeEnum.Yes:
      return OrderDirections.Long
    case BinaryOptionMarketStatsOutcomeEnum.No:
      return OrderDirections.Short
    default:
      return null
  }
}

export type BOSettlementResult = 'won' | 'lost' | 'refunded'

// exitPrice is the held side's settlement price; a refund settles at the market's default price instead of 1 or 0.
export const getBOSettlementResult = (exitPrice: number): BOSettlementResult => {
  if (exitPrice === BO_SETTLEMENT_VALUE) return 'won'
  if (exitPrice === 0) return 'lost'
  return 'refunded'
}

export interface BOClosedPosition {
  direction: OrderDirections
  shares: number
  avgPrice: number
  avgExitPrice: number
  cost: number
  payout: number
  pnl: number
  pnlPercentage: number | null
  result: BOSettlementResult
  won: boolean
}

// A settlement row puts an Up holder on the ask side and a Down holder on the bid side.
export const getBOClosedPosition = (
  trade: Pick<
    WsTrade,
    | 'type'
    | 'ask_account_id'
    | 'bid_account_id'
    | 'price'
    | 'size'
    | 'usd_amount'
    | 'taker_entry_quote_before'
  >,
  accountIndex: number,
): BOClosedPosition | null => {
  if (trade.type !== TradeTypeEnum.MarketSettlement) return null

  const direction =
    trade.ask_account_id === accountIndex
      ? OrderDirections.Long
      : trade.bid_account_id === accountIndex
        ? OrderDirections.Short
        : null
  if (direction === null || trade.taker_entry_quote_before === null) return null

  const shares = trade.size
  const cost = trade.taker_entry_quote_before
  const payout = Number(trade.usd_amount)
  const avgExitPrice = getBOSidePrice(trade.price, direction)
  const result = getBOSettlementResult(avgExitPrice)
  const pnl = roundNumber(payout - cost, BO_QUOTE_DECIMALS)
  return {
    direction,
    shares,
    avgPrice: cost / shares,
    avgExitPrice,
    cost,
    payout,
    pnl,
    pnlPercentage: cost > 0 ? roundNumber((pnl / cost) * 100, BO_QUOTE_DECIMALS) : null,
    result,
    won: result === 'won',
  }
}

export interface BOOpenPosition {
  direction: OrderDirections
  avgPrice: number
  midPrice: number | null
  value: number | null
  pnl: number | null
  pnlPercentage: number | null
  payout: number | null
}

export type BOPositionPriceStats = Pick<
  WsBOMarketStats,
  'mid_price' | 'last_trade_price' | 'outcome' | 'status'
>

export const getBOPositionPrice = (
  direction: OrderDirections,
  avgEntryPrice: number,
  stats: BOPositionPriceStats | undefined,
): number | null => {
  if (stats === undefined) return avgEntryPrice
  if (stats.status === BinaryOptionMarketStatsStatusEnum.WaitingForSettlement) return avgEntryPrice
  const settledDirection = getBOSettledDirection(stats)
  if (settledDirection !== null) return settledDirection === direction ? BO_SETTLEMENT_VALUE : 0
  if (isBORefunded(stats)) return BO_REFUND_PRICE
  const upPrice =
    getBOStatsMidPrice(stats) ?? (stats.last_trade_price > 0 ? stats.last_trade_price : null)
  return upPrice === null ? avgEntryPrice : getBOSidePrice(upPrice, direction)
}

// avg_entry_price is already in the held side's terms (the backend's OutcomeAverageEntryPrice), unlike the YES prices
// everywhere else, so it is never flipped.
export const getBOOpenPosition = (
  position: Pick<WsBOPosition, 'sign' | 'avg_entry_price' | 'size'>,
  stats: BOPositionPriceStats | undefined,
): BOOpenPosition => {
  const direction = position.sign > 0 ? OrderDirections.Long : OrderDirections.Short
  const avgPrice = position.avg_entry_price
  if (stats?.status === BinaryOptionMarketStatsStatusEnum.WaitingForSettlement) {
    return {
      direction,
      avgPrice,
      midPrice: null,
      value: null,
      pnl: null,
      pnlPercentage: null,
      payout: null,
    }
  }
  const upPrice = getBOStatsMidPrice(stats)
  const midPrice = upPrice === null ? null : getBOSidePrice(upPrice, direction)
  const price = getBOPositionPrice(direction, avgPrice, stats)
  const settledDirection = getBOSettledDirection(stats)
  return {
    direction,
    avgPrice,
    midPrice,
    value: price === null ? null : roundNumber(price * position.size, BO_QUOTE_DECIMALS),
    pnl: price === null ? null : roundNumber((price - avgPrice) * position.size, BO_QUOTE_DECIMALS),
    pnlPercentage:
      price === null || avgPrice <= 0
        ? null
        : roundNumber(((price - avgPrice) / avgPrice) * 100, BO_QUOTE_DECIMALS),
    payout:
      settledDirection !== null
        ? settledDirection === direction
          ? position.size
          : 0
        : isBORefunded(stats)
          ? roundNumber(position.size * BO_REFUND_PRICE, BO_QUOTE_DECIMALS)
          : position.size,
  }
}

export const sumBOOpenPositions = (
  positions: Pick<BOOpenPosition, 'value' | 'pnl'>[],
  metric: 'value' | 'pnl',
): number | null =>
  positions.reduce<number | null>(
    (sum, position) => {
      const amount = position[metric]
      return amount === null ? sum : (sum ?? 0) + amount
    },
    positions.length === 0 ? 0 : null,
  )

export const getBOProbabilityChange = (
  yes: number | null,
  dailyPriceChange: number | null | undefined,
): number | null => {
  if (yes === null || dailyPriceChange == null) return null
  if (!Number.isFinite(yes) || !Number.isFinite(dailyPriceChange) || dailyPriceChange <= -1) {
    return null
  }
  return roundNumber(yes - yes / (1 + dailyPriceChange), 4)
}

// A settlement row puts an Up holder on the ask side, unlike a trade where the bid buys Up.
export const getBOTradeDirection = (
  trade: Pick<WsTrade, 'type' | 'bid_account_id'>,
  accountIndex: number,
): OrderDirections => {
  const isBid = trade.bid_account_id === accountIndex
  const holdsUp = trade.type === TradeTypeEnum.MarketSettlement ? !isBid : isBid
  return holdsUp ? OrderDirections.Long : OrderDirections.Short
}

export type BOTradeAction = 'buy' | 'sell' | BOSettlementResult

export interface BOTradeFill {
  action: BOTradeAction | null
  direction: OrderDirections
  price: number
  size: number
  value: number
  avgEntryPrice: number | null
  pnl: number | null
  pnlPercentage: number | null
}

const getBOPnlPercentage = (pnl: number | null, cost: number | null) =>
  pnl === null || cost === null || !(cost > 0)
    ? null
    : roundNumber((pnl / cost) * 100, BO_QUOTE_DECIMALS)

const getBOFillLeg = (
  action: BOTradeAction | null,
  direction: OrderDirections,
  upPrice: number,
  size: number,
  avgEntryPrice: number | null = null,
): BOTradeFill => {
  const price = getBOSidePrice(upPrice, direction)
  const pnl =
    avgEntryPrice === null ? null : roundNumber((price - avgEntryPrice) * size, BO_QUOTE_DECIMALS)
  return {
    action,
    direction,
    price,
    size,
    value: roundNumber(price * size, BO_QUOTE_DECIMALS),
    avgEntryPrice,
    pnl,
    pnlPercentage: getBOPnlPercentage(pnl, avgEntryPrice === null ? null : avgEntryPrice * size),
  }
}

// A fill larger than the held position sells it first and buys the other side with the rest.
export const getBOTradeFills = (
  trade: Pick<
    WsTrade,
    | 'type'
    | 'is_maker_ask'
    | 'ask_account_id'
    | 'bid_account_id'
    | 'price'
    | 'size'
    | 'usd_amount'
    | 'taker_position_size_before'
    | 'maker_position_size_before'
    | 'taker_entry_quote_before'
    | 'maker_entry_quote_before'
  >,
  accountIndex: number,
): BOTradeFill[] => {
  const direction = getBOTradeDirection(trade, accountIndex)
  if (trade.type === TradeTypeEnum.MarketSettlement) {
    const exitPrice = getBOSidePrice(trade.price, direction)
    const cost = trade.taker_entry_quote_before
    const pnl =
      cost === null ? null : roundNumber(Number(trade.usd_amount) - cost, BO_QUOTE_DECIMALS)
    return [
      {
        action: getBOSettlementResult(exitPrice),
        direction,
        price: exitPrice,
        size: trade.size,
        value: Number(trade.usd_amount),
        avgEntryPrice: cost === null || !(trade.size > 0) ? null : cost / trade.size,
        pnl,
        pnlPercentage: getBOPnlPercentage(pnl, cost),
      },
    ]
  }
  const isAsk = trade.ask_account_id === accountIndex
  const isMaker = trade.is_maker_ask === isAsk
  const before = isMaker ? trade.maker_position_size_before : trade.taker_position_size_before
  if (before === null) return [getBOFillLeg(null, direction, trade.price, trade.size)]

  const held = isAsk ? Math.max(before, 0) : Math.max(-before, 0)
  if (held === 0) return [getBOFillLeg('buy', direction, trade.price, trade.size)]

  const heldSide = isAsk ? OrderDirections.Long : OrderDirections.Short
  const sold = Math.min(held, trade.size)
  // The same closed PnL as the backend's trade export (formatBinaryOptionsClosedPnl), fees excluded.
  const entryQuote = isMaker ? trade.maker_entry_quote_before : trade.taker_entry_quote_before
  const avgEntryPrice = entryQuote === null ? null : entryQuote / held
  const legs = [getBOFillLeg('sell', heldSide, trade.price, sold, avgEntryPrice)]
  if (trade.size > sold) {
    legs.push(getBOFillLeg('buy', direction, trade.price, trade.size - sold))
  }
  return legs
}

type BOOrderTrade = Parameters<typeof getBOTradeFills>[0] &
  Pick<WsTrade, 'trade_id' | 'ask_id' | 'bid_id' | 'ask_id_str' | 'bid_id_str'>

const getBOOrderTradeId = (trade: BOOrderTrade, isAsk: boolean): string | null => {
  const exact = isAsk ? trade.ask_id_str : trade.bid_id_str
  if (exact) return exact
  const id = isAsk ? trade.ask_id : trade.bid_id
  return Number.isSafeInteger(id) ? String(id) : null
}

// Orders carry no buy/sell intent, so a sale is read from the order's first fill, as in trade history.
// The account keeps a bounded trade window, so the order is only judged when all its fills are present.
export const getBOOrderSoldDirection = (
  order: Pick<WsOrder, 'order_id' | 'is_ask' | 'filled_base_amount'>,
  trades: readonly BOOrderTrade[],
  accountIndex: number,
): OrderDirections | null => {
  let first: BOOrderTrade | undefined
  let filled = 0
  for (const trade of trades) {
    const accountId = order.is_ask ? trade.ask_account_id : trade.bid_account_id
    if (accountId !== accountIndex || getBOOrderTradeId(trade, order.is_ask) !== order.order_id) {
      continue
    }
    filled += trade.size
    if (first === undefined || trade.trade_id < first.trade_id) first = trade
  }
  if (
    first === undefined ||
    roundNumber(filled, BO_SIZE_DECIMALS) < roundNumber(order.filled_base_amount, BO_SIZE_DECIMALS)
  ) {
    return null
  }
  const [leg] = getBOTradeFills(first, accountIndex)
  return leg?.action === 'sell' ? leg.direction : null
}

export const getBOUpDownOutcome = (
  price: number | null,
  priceToBeat: number | null,
): OrderDirections | null => {
  if (price === null || priceToBeat === null) return null
  return price >= priceToBeat ? OrderDirections.Long : OrderDirections.Short
}

export interface PriceToBeatMove {
  distance: number
  bps: number | null
}

export const getPriceToBeatMove = (
  price: number | null,
  priceToBeat: number | null,
): PriceToBeatMove | null => {
  if (price === null || priceToBeat === null) return null
  const distance = price - priceToBeat
  return {
    distance,
    bps: priceToBeat > 0 ? (distance / priceToBeat) * 10_000 : null,
  }
}

export const clampBOPrice = (
  price: number,
  market: Pick<EventOrderBookEntry, 'price_decimals'>,
): number => {
  const tick = 10 ** -market.price_decimals
  return roundNumber(
    Math.min(1 - tick, Math.max(tick, roundNumber(price, market.price_decimals))),
    market.price_decimals,
  )
}

// Market fees arrive as percentages: "0.0450" is 0.045%
const parseBOMarketFee = (fee: string, enabled: boolean): number =>
  enabled ? Number(fee) / 100 : 0

export interface BOFeeRates {
  taker: number
  maker: number
}

// The rate a side pays as the price approaches 0, after the account's binary options multiplier
export const getBOFeeRates = (
  market: Pick<
    EventOrderBookEntry,
    'taker_fee' | 'maker_fee' | 'is_taker_fee_enabled' | 'is_maker_fee_enabled'
  >,
  accountFeeRates: BOFeeRates,
): BOFeeRates => ({
  taker: parseBOMarketFee(market.taker_fee, market.is_taker_fee_enabled) * accountFeeRates.taker,
  maker: parseBOMarketFee(market.maker_fee, market.is_maker_fee_enabled) * accountFeeRates.maker,
})

// Both sides of a trade at Up price P pay rate × shares × P × (1 − P), so either side's price gives the same fee
export const getBOTradeFee = (rate: number, shares: number, price: number): number =>
  rate * shares * price * (BO_SETTLEMENT_VALUE - price)

export const getBORowTouchPrice = (
  stats: WsBOMarketStats,
  direction: OrderDirections,
): number | null => {
  if (direction === OrderDirections.Long) {
    return stats.best_ask_price > 0 ? stats.best_ask_price : null
  }

  return stats.best_bid_price > 0 ? flipBOPrice(stats.best_bid_price) : null
}

export const getBOSideTouchPrice = (
  stats: WsBOMarketStats,
  direction: OrderDirections,
  side: BOSide,
): number | null => {
  if (side === 'buy') return getBORowTouchPrice(stats, direction)
  const price = getBORowTouchPrice(
    stats,
    direction === OrderDirections.Long ? OrderDirections.Short : OrderDirections.Long,
  )
  return price === null ? null : flipBOPrice(price)
}

export const BO_FAR_FROM_MID_GAP = 0.05
const BO_FAR_FROM_MID_EPSILON = 1e-9

export interface BOMidCheck {
  bestPrice: number | null
  midPrice: number | null
  farFromMid: boolean
}

// A book with one side empty reports no mid, so any fill on it counts as far from the mid.
export const getBOMidCheckAtPrice = (
  stats: WsBOMarketStats | undefined,
  direction: OrderDirections,
  bestPrice: number | null,
): BOMidCheck => {
  const upMidPrice = getBOStatsMidPrice(stats)
  const midPrice = upMidPrice === null ? null : getBOSidePrice(upMidPrice, direction)
  if (bestPrice === null) return { bestPrice, midPrice, farFromMid: false }
  if (stats === undefined || midPrice === null) return { bestPrice, midPrice, farFromMid: true }
  const unroundedUpMidPrice = (stats.best_bid_price + stats.best_ask_price) / 2
  const gap = Math.abs(getBOSidePrice(bestPrice, direction) - unroundedUpMidPrice)
  return {
    bestPrice,
    midPrice,
    farFromMid: gap >= BO_FAR_FROM_MID_GAP - BO_FAR_FROM_MID_EPSILON,
  }
}

export const getBOMidCheck = (
  stats: WsBOMarketStats | undefined,
  direction: OrderDirections,
  side: BOSide,
): BOMidCheck =>
  getBOMidCheckAtPrice(
    stats,
    direction,
    stats === undefined ? null : getBOSideTouchPrice(stats, direction, side),
  )

export const getBOMarketOrderPrice = (
  stats: WsBOMarketStats,
  direction: OrderDirections,
  priceToleranceCents: number,
  market: Pick<EventOrderBookEntry, 'price_decimals'>,
): number | null => {
  const touchPrice = getBORowTouchPrice(stats, direction)
  if (touchPrice === null) return null
  return clampBOPrice(touchPrice + priceToleranceCents / 100, market)
}

interface BORowOrder {
  baseAmount: number
  displayPrice: number
  marketPrice: number
  midPrice: number | null
  farFromMid: boolean
}

export const buildBORowOrder = ({
  quoteAmount,
  priceTolerance,
  stats,
  direction,
  market,
  isMarketDataLive,
}: {
  quoteAmount: number
  priceTolerance: number
  stats: WsBOMarketStats
  direction: OrderDirections
  market: Pick<EventOrderBookEntry, 'price_decimals' | 'size_decimals'>
  isMarketDataLive: boolean
}): BORowOrder | null => {
  if (!isMarketDataLive) return null

  const displayPrice = getBORowTouchPrice(stats, direction)
  if (displayPrice === null) return null

  const marketPrice = getBOMarketOrderPrice(stats, direction, priceTolerance, market)
  if (marketPrice === null) return null

  // Sized at the capped price, so a fill that walks the book up to it never costs more than quoteAmount.
  const baseAmount = floorNumber(quoteAmount / marketPrice, market.size_decimals)
  if (baseAmount <= 0) return null

  const { midPrice, farFromMid } = getBOMidCheck(stats, direction, 'buy')
  return { displayPrice, marketPrice, baseAmount, midPrice, farFromMid }
}

export interface BOAssetGroup {
  symbol: string
  events: [EventDetail, ...EventDetail[]]
  feedEvent: EventDetail
}

const BO_FEED_DURATION_MS = 5 * 60 * 1_000

// Prefers the soonest-ending occurrence that is still tradable; an ended
// occurrence only wins when no live one is listed.
const isPreferredBOEvent = (
  candidate: EventDetail,
  current: EventDetail,
  nowMs: number,
): boolean => {
  const candidateEnd = candidate.end_at
  const currentEnd = current.end_at
  const candidateLive = candidateEnd > nowMs
  const currentLive = currentEnd > nowMs
  if (candidateLive !== currentLive) return candidateLive
  return candidateLive ? candidateEnd < currentEnd : candidateEnd > currentEnd
}

export const projectBOAssetGroups = (events: EventDetail[], nowMs: number): BOAssetGroup[] => {
  const groupedEvents = new Map<string, Map<number, EventDetail>>()

  events.forEach((event) => {
    const symbol = getBOEventSymbol(event)
    const durationMs = getBOEventDurationMs(event)
    if (symbol === undefined) {
      return
    }

    const eventsByDuration = groupedEvents.get(symbol) ?? new Map<number, EventDetail>()
    const currentEvent = eventsByDuration.get(durationMs)

    if (currentEvent === undefined || isPreferredBOEvent(event, currentEvent, nowMs)) {
      eventsByDuration.set(durationMs, event)
    }

    groupedEvents.set(symbol, eventsByDuration)
  })

  return [...groupedEvents.entries()]
    .flatMap(([symbol, eventsByDuration]): BOAssetGroup[] => {
      const [first, ...rest] = [...eventsByDuration.values()].sort(
        (left, right) =>
          getBOEventDurationMs(left) - getBOEventDurationMs(right) || left.end_at - right.end_at,
      )
      if (first === undefined) return []
      const feedEvent =
        [first, ...rest].find((event) => getBOEventDurationMs(event) === BO_FEED_DURATION_MS) ??
        first
      return [{ symbol, events: [first, ...rest], feedEvent }]
    })
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
}

export const formatBODuration = (durationMs: number, t: TFunction): string => {
  if (durationMs < 60_000) return t('duration_seconds', { count: durationMs / 1_000 })

  const minutes = durationMs / 60_000

  if (minutes < 60) return t('duration_minutes', { count: minutes })

  return t('duration_hours', { count: minutes / 60 })
}

const lazyDateTimeFormatter = (options: Intl.DateTimeFormatOptions) => {
  let formatter: Intl.DateTimeFormat | undefined
  return () => {
    formatter ??= new Intl.DateTimeFormat(undefined, options)
    return formatter
  }
}

const getContractTimeFormatter = lazyDateTimeFormatter({
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const getContractSecondsFormatter = lazyDateTimeFormatter({
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export const formatBOContractWindow = (
  startTimestampMs: number,
  endTimestampMs: number,
): string => {
  const formatter =
    endTimestampMs - startTimestampMs < 60_000
      ? getContractSecondsFormatter()
      : getContractTimeFormatter()
  return `${formatter.format(startTimestampMs)}–${formatter.format(endTimestampMs)}`
}

const getTimeZoneFormatter = lazyDateTimeFormatter({ timeZoneName: 'shortOffset' })

export const formatBOTimeZone = (timestampMs: number): string =>
  getTimeZoneFormatter()
    .formatToParts(timestampMs)
    .find((part) => part.type === 'timeZoneName')?.value ?? ''
