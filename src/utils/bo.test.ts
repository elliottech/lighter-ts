import { describe, expect, it } from 'vitest'

import {
  BinaryOptionMarketStatsOutcomeEnum,
  BinaryOptionMarketStatsStatusEnum,
  type EventDetail,
  TradeTypeEnum,
} from 'zklighter-perps'

import { OrderDirections } from '../constants/shared'
import type { WsBOMarketStats, WsTrade } from '../lighter-ws/types/WsMessage'
import {
  getBOAssetGroupClosestEvent,
  getBOClosedPosition,
  getBOFilledPrice,
  getBOOpenPosition,
  getBOPositionPrice,
  getBOProbabilityChange,
  getBOSidePrice,
  getBOSettlementResult,
  clampBOPrice,
  getBOLimitMidPrice,
  getBOStatsMidPrice,
  getBOSidedOrderBook,
  getBOTradeDirection,
  getBOOrderSoldDirection,
  getBOTradeFills,
  getBOUpDownOutcome,
  getPriceToBeatMove,
  sanitizeBOLimitPriceInput,
  sumBOOpenPositions,
  toBOLimitPriceInputValue,
  getBOEventBoundaryPrices,
  getBOEventSlug,
  getBOFeeRates,
  getBOTradeFee,
  isBORefunded,
  parseBOMarketSymbol,
  buildBORowOrder,
  getBOMidCheck,
  getBOMidCheckAtPrice,
} from './bo'
import {
  formatMarketPrice,
  formatOraclePrice,
  formatBOMovePercent,
  formatSignedPriceToBeatMove,
  getOracleDisplayDecimals,
} from './formatting'
import { getBOTradeFeePaid } from './getBOTradeFeePaid'

describe('parseBOMarketSymbol', () => {
  it('parses an up/down market symbol', () => {
    expect(parseBOMarketSymbol('BTC-UPDOWN-5M-1789504500')).toEqual({
      symbol: 'BTC',
      slug: 'btc-updown-5m-1789504500',
      occurrenceStartAt: 1_789_504_500_000,
      occurrenceEndAt: 1_789_504_800_000,
    })
  })

  it('parses a seconds duration', () => {
    expect(parseBOMarketSymbol('ETH-UPDOWN-30S-1789504500')?.occurrenceEndAt).toBe(
      1_789_504_530_000,
    )
  })

  it('matches the event slug', () => {
    expect(parseBOMarketSymbol('BTC-UPDOWN-5M-1789504500')?.slug).toBe(
      getBOEventSlug({ tag: 'btc-updown-5m', start_at: 1_789_504_500_000 }),
    )
  })

  it('rejects other symbols', () => {
    expect(parseBOMarketSymbol('BTC')).toBeUndefined()
    expect(parseBOMarketSymbol('BTC-UPDOWN-5M')).toBeUndefined()
    expect(parseBOMarketSymbol('btc-updown-5m-1789504500')).toBeUndefined()
  })
})

const boEvent = (
  event_id: number,
  start_at: number,
  metadata: Record<string, string> = {},
  tag = 'btc-updown-15m',
) => ({ event_id, tag, start_at, end_at: start_at + 900_000, metadata }) as unknown as EventDetail

describe('getBOEventBoundaryPrices', () => {
  it("maps a series' resolved start and settlement prices by second", () => {
    const prices = getBOEventBoundaryPrices(
      [
        boEvent(1, 0, { start_price: '100', settlement_price: '101' }),
        boEvent(2, 900_000, { start_price: '101' }),
        boEvent(3, 0, { start_price: '5' }, 'eth-updown-15m'),
      ],
      'btc-updown-15m',
    )
    expect([...prices]).toEqual([
      [0, 100],
      [900, 101],
    ])
  })
})

describe('getBOFeeRates', () => {
  const market = {
    taker_fee: '1.0000',
    maker_fee: '0.5000',
    is_taker_fee_enabled: true,
    is_maker_fee_enabled: true,
  }

  it('applies each side its own account multiplier', () => {
    const rates = getBOFeeRates(market, { taker: 0.72, maker: 0.4 })
    expect(rates.taker).toBeCloseTo(0.0072)
    expect(rates.maker).toBeCloseTo(0.002)
  })

  it('turns a negative maker multiplier into a rebate', () => {
    const rates = getBOFeeRates(market, { taker: 1, maker: -0.5 })
    expect(rates.taker).toBeCloseTo(0.01)
    expect(rates.maker).toBeCloseTo(-0.0025)
  })

  it('charges nothing when a fee is disabled', () => {
    expect(
      getBOFeeRates(
        { ...market, is_taker_fee_enabled: false, is_maker_fee_enabled: false },
        { taker: 1, maker: 1 },
      ),
    ).toEqual({ taker: 0, maker: 0 })
  })
})

describe('getBOTradeFee', () => {
  it('is the same for either side of the trade', () => {
    expect(getBOTradeFee(0.01, 100, 0.3)).toBeCloseTo(0.21)
    expect(getBOTradeFee(0.01, 100, 0.7)).toBeCloseTo(0.21)
  })

  it('is zero at the price bounds', () => {
    expect(getBOTradeFee(0.01, 100, 0)).toBe(0)
    expect(getBOTradeFee(0.01, 100, 1)).toBe(0)
  })
})

describe('getBOClosedPosition', () => {
  const NIL_ACCOUNT = 281_474_976_710_655
  const settlement = {
    type: TradeTypeEnum.MarketSettlement,
    ask_account_id: NIL_ACCOUNT,
    bid_account_id: 2336,
    price: 0,
    size: 10,
    usd_amount: 10,
    taker_entry_quote_before: 5.8,
  }

  it('reads a winning Down position from the bid side', () => {
    const position = getBOClosedPosition(settlement, 2336)
    expect(position).toMatchObject({
      direction: OrderDirections.Short,
      shares: 10,
      cost: 5.8,
      payout: 10,
      avgExitPrice: 1,
      result: 'won',
      won: true,
    })
    expect(position?.avgPrice).toBeCloseTo(0.58)
    expect(position?.pnl).toBeCloseTo(4.2)
    expect(position?.pnlPercentage).toBeCloseTo(72.41, 2)
  })

  it('reads a losing Up position from the ask side', () => {
    const position = getBOClosedPosition(
      {
        ...settlement,
        ask_account_id: 140,
        bid_account_id: NIL_ACCOUNT,
        size: 315.705,
        usd_amount: 0,
        taker_entry_quote_before: 126.5853,
      },
      140,
    )
    expect(position).toMatchObject({ direction: OrderDirections.Long, won: false, payout: 0 })
    expect(position?.pnl).toBeCloseTo(-126.5853)
    expect(position?.pnlPercentage).toBe(-100)
  })

  it('keeps the PnL and its percentage cent-exact after float subtraction', () => {
    const position = getBOClosedPosition(
      { ...settlement, price: 0.5, size: 7, usd_amount: 3.5, taker_entry_quote_before: 2.66 },
      2336,
    )
    expect(position?.pnl).toBe(0.84)
    expect(position?.pnlPercentage).toBe(31.578947)
  })

  it('has no percentage for a zero cost basis', () => {
    expect(
      getBOClosedPosition({ ...settlement, taker_entry_quote_before: 0 }, 2336)?.pnlPercentage,
    ).toBeNull()
  })

  it('reads a refund at the default price for both sides', () => {
    const refund = { ...settlement, price: 0.5, usd_amount: 5 }
    expect(getBOClosedPosition(refund, 2336)).toMatchObject({
      avgExitPrice: 0.5,
      result: 'refunded',
      won: false,
    })
    expect(
      getBOClosedPosition({ ...refund, ask_account_id: 140, bid_account_id: NIL_ACCOUNT }, 140),
    ).toMatchObject({ direction: OrderDirections.Long, avgExitPrice: 0.5, result: 'refunded' })
  })

  it('ignores regular trades, other accounts and a missing cost basis', () => {
    expect(getBOClosedPosition({ ...settlement, type: TradeTypeEnum.Trade }, 2336)).toBeNull()
    expect(getBOClosedPosition(settlement, 7)).toBeNull()
    expect(getBOClosedPosition({ ...settlement, taker_entry_quote_before: null }, 2336)).toBeNull()
  })
})

describe('getBOSidePrice', () => {
  it('keeps the Up price and flips it for Down', () => {
    expect(getBOSidePrice(0.37, OrderDirections.Long)).toBe(0.37)
    expect(getBOSidePrice(0.37, OrderDirections.Short)).toBe(0.63)
  })
})

describe('getBOLimitMidPrice', () => {
  const stats = { mid_price: 0.51, best_bid_price: 0.5, best_ask_price: 0.51 }

  it('rounds a half-tick mid down to the resting side for Up and Down', () => {
    expect(getBOLimitMidPrice(stats, OrderDirections.Long)).toBe(0.5)
    expect(getBOLimitMidPrice(stats, OrderDirections.Short)).toBe(0.49)
  })

  it('keeps an exact mid', () => {
    const wide = { mid_price: 0.5, best_bid_price: 0.4, best_ask_price: 0.6 }
    expect(getBOLimitMidPrice(wide, OrderDirections.Long)).toBe(0.5)
    expect(getBOLimitMidPrice(wide, OrderDirections.Short)).toBe(0.5)
  })

  it('falls back to the stats mid with one side empty, and to null without stats', () => {
    const oneSided = { mid_price: 0.37, best_bid_price: 0.37, best_ask_price: 0 }
    expect(getBOLimitMidPrice(oneSided, OrderDirections.Long)).toBe(0.37)
    expect(getBOLimitMidPrice(oneSided, OrderDirections.Short)).toBe(0.63)
    expect(getBOLimitMidPrice(undefined, OrderDirections.Long)).toBeNull()
  })
})

describe('getBOFilledPrice', () => {
  it('keeps the average fill price of an Up order', () => {
    expect(
      getBOFilledPrice({ is_ask: false, filled_base_amount: 50, filled_quote_amount: 32.45 }),
    ).toBeCloseTo(0.649)
  })

  it('flips the average fill price of a Down order', () => {
    expect(
      getBOFilledPrice({
        is_ask: true,
        filled_base_amount: 549.7349,
        filled_quote_amount: 54.163341,
      }),
    ).toBeCloseTo(0.9)
  })

  it('returns null when nothing filled', () => {
    expect(
      getBOFilledPrice({ is_ask: true, filled_base_amount: 0, filled_quote_amount: 0 }),
    ).toBeNull()
  })
})

describe('limit price input', () => {
  it('converts a price to cents', () => {
    expect(toBOLimitPriceInputValue(0.37)).toBe('37')
  })

  it('accepts 1 to 99 cents and clearing', () => {
    expect(sanitizeBOLimitPriceInput('99')).toBe('99')
    expect(sanitizeBOLimitPriceInput('1')).toBe('1')
    expect(sanitizeBOLimitPriceInput('')).toBe('')
    expect(sanitizeBOLimitPriceInput('100')).toBeNull()
    expect(sanitizeBOLimitPriceInput('0')).toBeNull()
  })

  it('rejects fractions of a cent', () => {
    expect(sanitizeBOLimitPriceInput('12.5')).toBeNull()
  })
})

const activeStats = {
  mid_price: 0.5,
  last_trade_price: 0,
  outcome: BinaryOptionMarketStatsOutcomeEnum.None,
  status: BinaryOptionMarketStatsStatusEnum.Active,
}

describe('getBOOpenPosition', () => {
  it('keeps the backend average, already in the held side terms', () => {
    const position = getBOOpenPosition({ sign: -1, avg_entry_price: 0.4, size: 10 }, {
      mid_price: 0.3,
      outcome: undefined,
    } as never)
    expect(position.direction).toBe(OrderDirections.Short)
    expect(position.avgPrice).toBe(0.4)
    expect(position.midPrice).toBe(0.7)
    expect(position.value).toBe(7)
    expect(position.pnl).toBe(3)
    expect(position.payout).toBe(10)
  })

  it('values nothing between the window closing and its settlement', () => {
    const position = getBOOpenPosition(
      { sign: 1, avg_entry_price: 0.4, size: 10 },
      {
        ...activeStats,
        mid_price: 0.3,
        status: BinaryOptionMarketStatsStatusEnum.WaitingForSettlement,
      },
    )
    expect(position).toMatchObject({
      direction: OrderDirections.Long,
      avgPrice: 0.4,
      midPrice: null,
      value: null,
      pnl: null,
      pnlPercentage: null,
      payout: null,
    })
    expect(sumBOOpenPositions([position, { value: 5, pnl: 1 }], 'value')).toBe(5)
  })

  it('keeps the percentage free of float noise', () => {
    const position = getBOOpenPosition({ sign: -1, avg_entry_price: 0.4, size: 10 }, {
      mid_price: 0.61,
      outcome: undefined,
    } as never)
    expect(position.pnlPercentage).toBe(-2.5)
  })

  it('pays the default price on both sides of a refund, in settlement or settled', () => {
    for (const status of ['in-settlement', 'settled'])
      for (const sign of [1, -1] as const) {
        const position = getBOOpenPosition({ sign, avg_entry_price: 0.4, size: 10 }, {
          mid_price: 0,
          outcome: 0,
          status,
        } as never)
        expect(position.payout).toBe(5)
      }
  })

  it('pays the full size if it wins while the market is not settled yet', () => {
    const position = getBOOpenPosition(
      { sign: 1, avg_entry_price: 0.4, size: 10 },
      {
        mid_price: 0.5,
        last_trade_price: 0,
        outcome: BinaryOptionMarketStatsOutcomeEnum.Yes,
        status: BinaryOptionMarketStatsStatusEnum.InSettlement,
      },
    )
    expect(position.payout).toBe(10)
  })

  it('pays nothing once the other side won', () => {
    const position = getBOOpenPosition({ sign: 1, avg_entry_price: 0.4, size: 10 }, {
      mid_price: 0,
      outcome: 1,
    } as never)
    expect(position.payout).toBe(0)
  })

  it('keeps the Price column empty for an empty book mid of 0', () => {
    const position = getBOOpenPosition(
      { sign: -1, avg_entry_price: 0.4, size: 100 },
      {
        ...activeStats,
        mid_price: 0,
      },
    )
    expect(position.midPrice).toBeNull()
    expect(position.payout).toBe(100)
  })

  it('values a position at its entry price without market stats', () => {
    const position = getBOOpenPosition({ sign: 1, avg_entry_price: 0.4, size: 10 }, undefined)
    expect(position.value).toBe(4)
    expect(position.pnl).toBe(0)
    expect(sumBOOpenPositions([position], 'value')).toBe(4)
  })

  it('values a won position with an empty mid at the full payout', () => {
    const position = getBOOpenPosition(
      { sign: -1, avg_entry_price: 0.4, size: 10 },
      {
        ...activeStats,
        mid_price: 0,
        outcome: BinaryOptionMarketStatsOutcomeEnum.No,
        status: BinaryOptionMarketStatsStatusEnum.Settled,
      },
    )
    expect(position.midPrice).toBeNull()
    expect(position.value).toBe(10)
    expect(position.pnl).toBe(6)
    expect(position.pnlPercentage).toBe(150)
  })

  it('values a lost position with an empty mid at zero', () => {
    const position = getBOOpenPosition(
      { sign: 1, avg_entry_price: 0.4, size: 10 },
      {
        ...activeStats,
        mid_price: 0,
        outcome: BinaryOptionMarketStatsOutcomeEnum.No,
        status: BinaryOptionMarketStatsStatusEnum.InSettlement,
      },
    )
    expect(position.value).toBe(0)
    expect(position.pnl).toBe(-4)
    expect(position.pnlPercentage).toBe(-100)
  })

  it('values a refunded position with an empty mid at the refund price', () => {
    const position = getBOOpenPosition(
      { sign: 1, avg_entry_price: 0.4, size: 10 },
      {
        ...activeStats,
        mid_price: 0,
        status: BinaryOptionMarketStatsStatusEnum.Settled,
      },
    )
    expect(position.value).toBe(5)
    expect(position.pnl).toBe(1)
    expect(position.pnlPercentage).toBe(25)
  })

  it('values an active position without a mid at the last trade, flipped to the held side', () => {
    const position = getBOOpenPosition(
      { sign: -1, avg_entry_price: 0.4, size: 10 },
      {
        ...activeStats,
        mid_price: 0,
        last_trade_price: 0.7,
      },
    )
    expect(position.midPrice).toBeNull()
    expect(position.value).toBe(3)
    expect(position.pnl).toBe(-1)
    expect(position.pnlPercentage).toBe(-25)
  })

  it('values an active position without a mid or a trade at its avg entry price', () => {
    const position = getBOOpenPosition(
      { sign: -1, avg_entry_price: 0.4, size: 10 },
      {
        ...activeStats,
        mid_price: 0,
      },
    )
    expect(position.value).toBe(4)
    expect(position.pnl).toBe(0)
    expect(position.pnlPercentage).toBe(0)
  })
})

describe('getBOPositionPrice', () => {
  it('prefers the mid over the last trade', () => {
    expect(
      getBOPositionPrice(OrderDirections.Short, 0.4, {
        ...activeStats,
        mid_price: 0.3,
        last_trade_price: 0.9,
      }),
    ).toBe(0.7)
  })

  it('falls back to the entry price without market stats', () => {
    expect(getBOPositionPrice(OrderDirections.Long, 0.4, undefined)).toBe(0.4)
  })
})

describe('sumBOOpenPositions', () => {
  it('sums the rows that have a value', () => {
    expect(
      sumBOOpenPositions(
        [
          { value: 3, pnl: 1 },
          { value: null, pnl: null },
        ],
        'value',
      ),
    ).toBe(3)
    expect(
      sumBOOpenPositions(
        [
          { value: 3, pnl: 1 },
          { value: null, pnl: null },
        ],
        'pnl',
      ),
    ).toBe(1)
  })

  it('is null only when every row is null', () => {
    expect(sumBOOpenPositions([{ value: null, pnl: null }], 'value')).toBeNull()
  })

  it('is zero without positions', () => {
    expect(sumBOOpenPositions([], 'value')).toBe(0)
  })
})

describe('isBORefunded', () => {
  it('is false for an active market', () => {
    expect(
      isBORefunded({
        outcome: BinaryOptionMarketStatsOutcomeEnum.None,
        status: BinaryOptionMarketStatsStatusEnum.Active,
      }),
    ).toBe(false)
  })

  it('is false for a settled market with a winning side', () => {
    expect(
      isBORefunded({
        outcome: BinaryOptionMarketStatsOutcomeEnum.Yes,
        status: BinaryOptionMarketStatsStatusEnum.Settled,
      }),
    ).toBe(false)
  })
})

describe('getBOProbabilityChange', () => {
  it('reads 0.50 to 0.60 as ten points', () => {
    expect(getBOProbabilityChange(0.6, 0.2)).toBe(0.1)
  })

  it('reads a fall as negative points', () => {
    expect(getBOProbabilityChange(0.3, -0.4)).toBe(-0.2)
  })

  it('is zero without a change', () => {
    expect(getBOProbabilityChange(0.6, 0)).toBe(0)
  })

  it('is unknown for a missing, non-finite or impossible change', () => {
    expect(getBOProbabilityChange(null, 0.2)).toBeNull()
    expect(getBOProbabilityChange(0.6, null)).toBeNull()
    expect(getBOProbabilityChange(0.6, undefined)).toBeNull()
    expect(getBOProbabilityChange(Number.NaN, 0.2)).toBeNull()
    expect(getBOProbabilityChange(0.6, Number.POSITIVE_INFINITY)).toBeNull()
    expect(getBOProbabilityChange(0.6, -1)).toBeNull()
    expect(getBOProbabilityChange(0.6, -1.5)).toBeNull()
  })
})

describe('getPriceToBeatMove', () => {
  it('returns the distance and bps above the price to beat', () => {
    const move = getPriceToBeatMove(100_010, 100_000)
    expect(move?.distance).toBe(10)
    expect(move?.bps).toBeCloseTo(1)
  })

  it('returns a negative move below the price to beat', () => {
    expect(getPriceToBeatMove(99_900, 100_000)?.bps).toBeCloseTo(-10)
  })

  it('omits bps when the price to beat is not positive', () => {
    expect(getPriceToBeatMove(5, 0)).toEqual({ distance: 5, bps: null })
  })

  it('returns null without both prices', () => {
    expect(getPriceToBeatMove(null, 100)).toBeNull()
    expect(getPriceToBeatMove(100, null)).toBeNull()
  })
})

const MAKER = 7
const TAKER = 50

const makeTrade = (overrides: Partial<WsTrade> = {}): WsTrade =>
  ({
    trade_id: 1,
    type: TradeTypeEnum.Trade,
    size: 1000,
    price: 0.4,
    is_maker_ask: true,
    ask_account_id: MAKER,
    bid_account_id: TAKER,
    taker_fee: 1200,
    maker_fee: 300,
    integrator_taker_fee: 0,
    integrator_maker_fee: 0,
    ...overrides,
  }) as WsTrade

describe('getBOTradeDirection', () => {
  it('is Up for the bid account and Down otherwise', () => {
    expect(getBOTradeDirection(makeTrade(), TAKER)).toBe(OrderDirections.Long)
    expect(getBOTradeDirection(makeTrade(), MAKER)).toBe(OrderDirections.Short)
  })

  it('reads a settlement ask as the Up holder', () => {
    const settlement = makeTrade({ type: TradeTypeEnum.MarketSettlement })
    expect(getBOTradeDirection(settlement, MAKER)).toBe(OrderDirections.Long)
    expect(getBOTradeDirection(settlement, TAKER)).toBe(OrderDirections.Short)
  })
})

describe('getBOUpDownOutcome', () => {
  it('resolves a tie Up', () => {
    expect(getBOUpDownOutcome(100, 100)).toBe(OrderDirections.Long)
    expect(getBOUpDownOutcome(101, 100)).toBe(OrderDirections.Long)
    expect(getBOUpDownOutcome(99, 100)).toBe(OrderDirections.Short)
    expect(getBOUpDownOutcome(null, 100)).toBeNull()
  })
})

describe('getBOTradeFeePaid', () => {
  it('charges the taker its tick on the notional', () => {
    expect(getBOTradeFeePaid(makeTrade(), TAKER)).toBeCloseTo(0.48)
  })

  it('charges the maker its own tick', () => {
    expect(getBOTradeFeePaid(makeTrade(), MAKER)).toBeCloseTo(0.12)
  })

  it('finds the maker on the bid side', () => {
    const trade = makeTrade({ is_maker_ask: false, ask_account_id: TAKER, bid_account_id: MAKER })
    expect(getBOTradeFeePaid(trade, MAKER)).toBeCloseTo(0.12)
    expect(getBOTradeFeePaid(trade, TAKER)).toBeCloseTo(0.48)
  })

  it('adds the integrator fee of the same role', () => {
    const trade = makeTrade({ integrator_taker_fee: 500, integrator_maker_fee: 100 })
    expect(getBOTradeFeePaid(trade, TAKER)).toBeCloseTo(0.68)
    expect(getBOTradeFeePaid(trade, MAKER)).toBeCloseTo(0.16)
  })

  it('is zero for a settlement trade the backend sends without fees', () => {
    const trade = {
      ...makeTrade({ type: TradeTypeEnum.MarketSettlement }),
      taker_fee: undefined,
      maker_fee: undefined,
      integrator_taker_fee: undefined,
      integrator_maker_fee: undefined,
    } as unknown as WsTrade
    expect(getBOTradeFeePaid(trade, TAKER)).toBe(0)
  })
})

describe('getBOSidedOrderBook', () => {
  const book = { asks: [{ price: 0.6, size: 1 }], bids: [{ price: 0.4, size: 2 }] }

  it('keeps the Up book', () => {
    expect(getBOSidedOrderBook(book, OrderDirections.Long)).toBe(book)
  })

  it('mirrors the book for Down', () => {
    expect(getBOSidedOrderBook(book, OrderDirections.Short)).toEqual({
      asks: [{ price: 0.6, size: 2 }],
      bids: [{ price: 0.4, size: 1 }],
    })
  })
})

describe('getBOAssetGroupClosestEvent', () => {
  const five = { start_at: 0, end_at: 300_000 }
  const fifteen = { start_at: 0, end_at: 900_000 }

  it('picks the running window that ends first', () => {
    expect(getBOAssetGroupClosestEvent([fifteen, five], 100_000)).toBe(five)
  })

  it('falls back to the chart event when none is running', () => {
    expect(getBOAssetGroupClosestEvent([fifteen, five], 1_000_000)).toBe(fifteen)
  })
})

describe('getBOTradeFills', () => {
  const ACCOUNT = 50
  const fills = (overrides: Partial<WsTrade>) =>
    getBOTradeFills(
      {
        type: TradeTypeEnum.Trade,
        is_maker_ask: false,
        ask_account_id: ACCOUNT,
        bid_account_id: 7,
        price: 0.67,
        size: 10,
        usd_amount: 6.7,
        taker_position_size_before: 0,
        maker_position_size_before: 0,
        taker_entry_quote_before: null,
        maker_entry_quote_before: null,
        ...overrides,
      },
      ACCOUNT,
    )

  it('reads an ask against a held Up position as selling Up', () => {
    const [leg] = fills({ taker_position_size_before: 10.0 })
    expect(leg).toMatchObject({
      action: 'sell',
      direction: OrderDirections.Long,
      price: 0.67,
      size: 10,
    })
    expect(leg?.value).toBeCloseTo(6.7)
  })

  it('realizes the PnL of an Up sale against its average entry', () => {
    // Bought 10 Up at 40¢, sells 5 at 70¢: (0.70 − 0.40) × 5.
    const [leg] = fills({
      price: 0.7,
      size: 5,
      usd_amount: 3.5,
      taker_position_size_before: 10,
      taker_entry_quote_before: 4.0,
    })
    expect(leg).toMatchObject({
      action: 'sell',
      direction: OrderDirections.Long,
      avgEntryPrice: 0.4,
      pnl: 1.5,
      pnlPercentage: 75,
    })
  })

  it('realizes the PnL of a Down sale at the Down price', () => {
    // Holds 10 Down at 60¢; a bid at Up 30¢ sells 4 Down at 70¢: (0.70 − 0.60) × 4.
    const [leg] = fills({
      ask_account_id: 7,
      bid_account_id: ACCOUNT,
      is_maker_ask: true,
      price: 0.3,
      size: 4,
      usd_amount: 1.2,
      taker_position_size_before: -10,
      taker_entry_quote_before: 6.0,
    })
    expect(leg).toMatchObject({ action: 'sell', direction: OrderDirections.Short, price: 0.7 })
    expect(leg?.pnl).toBeCloseTo(0.4)
    expect(leg?.avgEntryPrice).toBeCloseTo(0.6)
    expect(leg?.pnlPercentage).toBeCloseTo(16.67)
  })

  it('reads the maker fields when the account made the trade', () => {
    const [leg] = fills({
      is_maker_ask: true,
      price: 0.5,
      size: 2,
      usd_amount: 1,
      taker_position_size_before: 0,
      maker_position_size_before: 4,
      maker_entry_quote_before: 1.2,
    })
    expect(leg?.pnl).toBeCloseTo(0.4)
  })

  it('has no PnL on an opening buy or without an entry cost', () => {
    expect(fills({ taker_entry_quote_before: 0 })[0]).toMatchObject({
      avgEntryPrice: null,
      pnl: null,
      pnlPercentage: null,
    })
    expect(fills({ taker_position_size_before: 10 })[0]).toMatchObject({
      avgEntryPrice: null,
      pnl: null,
      pnlPercentage: null,
    })
  })

  it('realizes PnL only on the closed part of a fill that flips the position', () => {
    // Holds 5 Up at 40¢ and sells 10 at 67¢: 5 close for (0.67 − 0.40) × 5, 5 open Down.
    const legs = fills({ taker_position_size_before: 5, taker_entry_quote_before: 2.0 })
    expect(legs[0]?.pnl).toBeCloseTo(1.35)
    expect(legs[1]).toMatchObject({ action: 'buy', pnl: null })
  })

  it('realizes a settlement as its payout minus the cost of the shares held', () => {
    const [won] = fills({
      type: TradeTypeEnum.MarketSettlement,
      ask_account_id: ACCOUNT,
      bid_account_id: 281_474_976_710_655,
      price: 1,
      size: 10,
      usd_amount: 10,
      taker_entry_quote_before: 5.8,
    })
    expect(won?.pnl).toBeCloseTo(4.2)
    expect(won?.avgEntryPrice).toBeCloseTo(0.58)
    expect(won?.pnlPercentage).toBeCloseTo(72.41)
    const [refund] = fills({
      type: TradeTypeEnum.MarketSettlement,
      ask_account_id: ACCOUNT,
      bid_account_id: 281_474_976_710_655,
      price: 0.5,
      size: 5,
      usd_amount: 2.5,
      taker_entry_quote_before: 2.66,
    })
    expect(refund?.pnl).toBe(-0.16)
    expect(refund?.pnlPercentage).toBeCloseTo(-6.02)
  })

  it('splits a fill larger than the held position into a sell and a buy', () => {
    const legs = fills({ taker_position_size_before: 5 })
    expect(legs).toHaveLength(2)
    expect(legs[0]).toMatchObject({ action: 'sell', direction: OrderDirections.Long, size: 5 })
    expect(legs[0]?.value).toBeCloseTo(3.35)
    expect(legs[1]).toMatchObject({
      action: 'buy',
      direction: OrderDirections.Short,
      price: 0.33,
      size: 5,
    })
    expect(legs[1]?.value).toBeCloseTo(1.65)
  })

  it('reads an ask from a flat account as buying Down', () => {
    const [leg] = fills({ price: 0.01, size: 1020, usd_amount: 10.2 })
    expect(leg).toMatchObject({ action: 'buy', direction: OrderDirections.Short, price: 0.99 })
  })

  it('uses the maker side position when the account made the trade', () => {
    const [leg] = fills({
      is_maker_ask: true,
      maker_position_size_before: 15,
      taker_position_size_before: 0,
    })
    expect(leg?.action).toBe('sell')
  })

  it('reads a bid against a held Down position as selling Down', () => {
    const [leg] = fills({
      ask_account_id: 7,
      bid_account_id: ACCOUNT,
      is_maker_ask: true,
      price: 0.3,
      taker_position_size_before: -20,
    })
    expect(leg).toMatchObject({
      action: 'sell',
      direction: OrderDirections.Short,
      price: 0.7,
      size: 10,
    })
  })

  it('leaves the action unknown without the prior position', () => {
    const [leg] = fills({ taker_position_size_before: null })
    expect(leg).toMatchObject({ action: null, direction: OrderDirections.Short, price: 0.33 })
  })

  it('rounds the value to the quote precision', () => {
    const [leg] = fills({ taker_position_size_before: null, price: 0.4, size: 3 })
    expect(leg?.value).toBe(1.8)
  })

  it('reads a settlement as won or lost with the payout as value', () => {
    const [won] = fills({
      type: TradeTypeEnum.MarketSettlement,
      ask_account_id: 0,
      bid_account_id: ACCOUNT,
      price: 0,
      size: 1020,
      usd_amount: 1020,
    })
    expect(won).toEqual({
      action: 'won',
      direction: OrderDirections.Short,
      price: 1,
      size: 1020,
      value: 1020,
      avgEntryPrice: null,
      pnl: null,
      pnlPercentage: null,
    })
    expect(
      fills({ type: TradeTypeEnum.MarketSettlement, price: 0, size: 1458.7, usd_amount: 0 })[0]
        ?.action,
    ).toBe('lost')
  })
})

describe('getOracleDisplayDecimals', () => {
  const btc = { display_price_decimals: 1, multiplier: '1' }
  const eth = { display_price_decimals: 2, multiplier: '1' }

  it("keeps the market's decimals while the prices already read differently", () => {
    expect(
      getOracleDisplayDecimals(['82535.266607513099829248', '82589.91315024741400576'], btc),
    ).toBe(1)
    expect(getOracleDisplayDecimals([82535.27, 82535.27], btc)).toBe(1)
  })

  it('extends a near tie until the prices read differently', () => {
    // Both read 82,535.3 at BTC's one decimal; the settlement is decided on the full feed price.
    const decimals = getOracleDisplayDecimals([82535.26, 82535.31], btc)
    expect(decimals).toBe(2)
    expect(formatOraclePrice(82535.26, btc, decimals)).toBe('82,535.26')
    expect(formatOraclePrice(82535.31, btc, decimals)).toBe('82,535.31')
    expect(getOracleDisplayDecimals([2426.0039148, 2426.0041], eth)).toBe(4)
  })

  it('ignores missing prices and caps the extension', () => {
    expect(getOracleDisplayDecimals([null, 82535.26, undefined], btc)).toBe(1)
    expect(getOracleDisplayDecimals([1.000000001, 1.000000002], btc)).toBe(8)
  })
})

describe('formatOraclePrice', () => {
  const btc = { display_price_decimals: 1, multiplier: '1' }

  it('rounds an oracle price half at the display decimals, where market prices round up', () => {
    expect(formatOraclePrice(81420.824, btc)).toBe('81,420.8')
    expect(formatOraclePrice(81393.1316, btc)).toBe('81,393.1')
    expect(formatOraclePrice(81393.15, btc)).toBe('81,393.2')
    expect(formatMarketPrice(81420.824, btc)).toBe('81,420.9')
  })

  it('scales by the market multiplier and keeps fixed decimals', () => {
    expect(formatOraclePrice(12.3456, { display_price_decimals: 3, multiplier: '1000' })).toBe(
      '0.012',
    )
    expect(formatOraclePrice(4000, { display_price_decimals: 2, multiplier: '1' })).toBe('4,000.00')
  })
})

describe('formatSignedPriceToBeatMove', () => {
  const formatPrice = (price: number) => price.toFixed(2)

  it('signs the dollar distance and the percent', () => {
    expect(formatSignedPriceToBeatMove({ distance: 12, bps: 1.34 }, formatPrice)).toBe(
      '+$12.00 (+0.013%)',
    )
    expect(formatSignedPriceToBeatMove({ distance: -257, bps: -31.3 }, formatPrice)).toBe(
      '-$257.00 (-0.313%)',
    )
  })

  it('shows only the distance without a percent', () => {
    expect(formatSignedPriceToBeatMove({ distance: 5, bps: null }, formatPrice)).toBe('+$5.00')
  })
})

describe('formatBOMovePercent', () => {
  it('drops the sign and converts bps to percent', () => {
    expect(formatBOMovePercent(-31.3)).toBe('0.313%')
    expect(formatBOMovePercent(12_345.6)).toBe('123.456%')
    expect(formatBOMovePercent(0.04)).toBe('0%')
  })
})

describe('getBOStatsMidPrice', () => {
  it('reads an empty book as no price', () => {
    expect(getBOStatsMidPrice({ mid_price: 0 })).toBeNull()
    expect(getBOStatsMidPrice(undefined)).toBeNull()
    expect(getBOStatsMidPrice({ mid_price: 0.42 })).toBe(0.42)
  })
})

describe('getBOSettlementResult', () => {
  it('reads the held side exit price: 1 won, 0 lost, anything between refunded', () => {
    expect(getBOSettlementResult(1)).toBe('won')
    expect(getBOSettlementResult(0)).toBe('lost')
    expect(getBOSettlementResult(0.5)).toBe('refunded')
    expect(getBOSettlementResult(0.99)).toBe('refunded')
    expect(getBOSettlementResult(0.01)).toBe('refunded')
  })
})

describe('clampBOPrice', () => {
  it('rounds to the tick so touch + tolerance stays exact', () => {
    expect(clampBOPrice(0.12 + 0.02, { price_decimals: 2 })).toBe(0.14)
    expect(clampBOPrice(0, { price_decimals: 2 })).toBe(0.01)
    expect(clampBOPrice(1, { price_decimals: 2 })).toBe(0.99)
  })
})

describe('getBOOrderSoldDirection', () => {
  const ACCOUNT = 50
  const trade = (
    overrides: Partial<Parameters<typeof getBOOrderSoldDirection>[1][number]> = {},
  ) => ({
    type: TradeTypeEnum.Trade,
    trade_id: 1,
    is_maker_ask: true,
    ask_id: 900,
    ask_id_str: '900',
    bid_id: 901,
    bid_id_str: '901',
    ask_account_id: ACCOUNT,
    bid_account_id: 7,
    price: 0.7,
    size: 10,
    usd_amount: 7,
    taker_position_size_before: 0,
    maker_position_size_before: 10,
    taker_entry_quote_before: 0,
    maker_entry_quote_before: 4,
    ...overrides,
  })
  const upAsk = { order_id: '900', is_ask: true, filled_base_amount: 10 }
  const downBid = { order_id: '901', is_ask: false, filled_base_amount: 10 }

  it('reads a resting Up ask filled against held Up shares as selling Up', () => {
    expect(getBOOrderSoldDirection(upAsk, [trade()], ACCOUNT)).toBe(OrderDirections.Long)
  })

  it('reads a resting Up bid filled against held Down shares as selling Down', () => {
    const fill = trade({
      ask_account_id: 7,
      bid_account_id: ACCOUNT,
      is_maker_ask: false,
      maker_position_size_before: -10,
    })
    expect(getBOOrderSoldDirection(downBid, [fill], ACCOUNT)).toBe(OrderDirections.Short)
  })

  it('leaves a buy, another order or a missing fill unlabelled', () => {
    expect(
      getBOOrderSoldDirection(upAsk, [trade({ maker_position_size_before: 0 })], ACCOUNT),
    ).toBeNull()
    expect(
      getBOOrderSoldDirection(upAsk, [trade({ ask_id: 1, ask_id_str: '1' })], ACCOUNT),
    ).toBeNull()
    expect(getBOOrderSoldDirection(upAsk, [], ACCOUNT)).toBeNull()
  })

  it('judges the order by its first fill', () => {
    const fills = [
      trade({ trade_id: 2, size: 5, maker_position_size_before: 0 }),
      trade({ trade_id: 1, size: 5, maker_position_size_before: 10 }),
    ]
    expect(getBOOrderSoldDirection(upAsk, fills, ACCOUNT)).toBe(OrderDirections.Long)
  })

  it('stays unlabelled when older fills of the order fell out of the trade window', () => {
    const laterFill = trade({ trade_id: 9, size: 4, maker_position_size_before: 10 })
    expect(getBOOrderSoldDirection(upAsk, [laterFill], ACCOUNT)).toBeNull()
  })

  it('matches an id without its exact string only when it is a safe integer', () => {
    const noString = trade({ ask_id_str: null })
    expect(getBOOrderSoldDirection(upAsk, [noString], ACCOUNT)).toBe(OrderDirections.Long)
    const unsafe = trade({ ask_id: 2 ** 53 + 2, ask_id_str: null })
    expect(
      getBOOrderSoldDirection({ ...upAsk, order_id: String(2 ** 53 + 2) }, [unsafe], ACCOUNT),
    ).toBeNull()
  })
})

describe('getBOMidCheck', () => {
  const book = (best_bid_price: number, best_ask_price: number, mid_price: number) =>
    ({ best_bid_price, best_ask_price, mid_price }) as WsBOMarketStats

  it('flags a sale on a book whose asks are empty, which reports no mid', () => {
    expect(getBOMidCheck(book(0.01, 0, 0), OrderDirections.Long, 'sell')).toEqual({
      bestPrice: 0.01,
      midPrice: null,
      farFromMid: true,
    })
  })

  it('flags a buy on a book whose bids are empty', () => {
    expect(getBOMidCheck(book(0, 0.99, 0), OrderDirections.Long, 'buy').farFromMid).toBe(true)
  })

  it('flags a sale at least the gap below the mid', () => {
    expect(getBOMidCheck(book(0.01, 0.11, 0.06), OrderDirections.Long, 'sell').farFromMid).toBe(
      true,
    )
    expect(getBOMidCheck(book(0.45, 0.55, 0.5), OrderDirections.Long, 'sell').farFromMid).toBe(true)
    expect(getBOMidCheck(book(0.46, 0.54, 0.5), OrderDirections.Long, 'sell').farFromMid).toBe(
      false,
    )
  })

  it('flags a buy at least the gap above the mid, on either outcome', () => {
    expect(getBOMidCheck(book(0.01, 0.99, 0.5), OrderDirections.Long, 'buy').farFromMid).toBe(true)
    expect(getBOMidCheck(book(0.01, 0.99, 0.5), OrderDirections.Short, 'buy').farFromMid).toBe(true)
    expect(getBOMidCheck(book(0.49, 0.51, 0.5), OrderDirections.Short, 'buy')).toEqual({
      bestPrice: 0.51,
      midPrice: 0.5,
      farFromMid: false,
    })
  })

  it('measures the gap from the unrounded mid, which the API rounds to the cent', () => {
    for (const direction of [OrderDirections.Long, OrderDirections.Short]) {
      for (const side of ['buy', 'sell'] as const) {
        expect(getBOMidCheck(book(0.46, 0.55, 0.51), direction, side).farFromMid).toBe(false)
        expect(getBOMidCheck(book(0.46, 0.55, 0.505), direction, side).farFromMid).toBe(false)
      }
    }
  })

  it('still flags a gap of exactly five cents when the float subtraction lands just below it', () => {
    expect(0.35 - 0.3).toBeLessThan(0.05)
    for (const direction of [OrderDirections.Long, OrderDirections.Short]) {
      for (const side of ['buy', 'sell'] as const) {
        expect(getBOMidCheck(book(0.25, 0.35, 0.3), direction, side).farFromMid).toBe(true)
      }
    }
  })

  it('does not flag a sale above the mid or a missing best price', () => {
    expect(getBOMidCheck(book(0, 0.5, 0), OrderDirections.Long, 'sell').farFromMid).toBe(false)
    expect(getBOMidCheck(undefined, OrderDirections.Long, 'sell').farFromMid).toBe(false)
  })
})

describe('getBOMidCheckAtPrice', () => {
  const book = (best_bid_price: number, best_ask_price: number, mid_price: number) =>
    ({ best_bid_price, best_ask_price, mid_price }) as WsBOMarketStats

  it('flags a crossing buy limit 15 cents above the mid', () => {
    expect(getBOMidCheckAtPrice(book(0.45, 0.55, 0.5), OrderDirections.Long, 0.65)).toEqual({
      bestPrice: 0.65,
      midPrice: 0.5,
      farFromMid: true,
    })
    expect(
      getBOMidCheckAtPrice(book(0.45, 0.55, 0.5), OrderDirections.Short, 0.65).farFromMid,
    ).toBe(true)
  })

  it('does not flag a limit 4.5 cents from a half-cent mid', () => {
    const stats = book(0.46, 0.55, 0.505)
    expect(getBOMidCheckAtPrice(stats, OrderDirections.Long, 0.55).farFromMid).toBe(false)
    expect(getBOMidCheckAtPrice(stats, OrderDirections.Long, 0.46).farFromMid).toBe(false)
    expect(getBOMidCheckAtPrice(stats, OrderDirections.Short, 0.54).farFromMid).toBe(false)
    expect(getBOMidCheckAtPrice(stats, OrderDirections.Short, 0.45).farFromMid).toBe(false)
  })

  it('flags a crossing sell limit 15 cents below the mid', () => {
    expect(getBOMidCheckAtPrice(book(0.45, 0.55, 0.5), OrderDirections.Long, 0.35).farFromMid).toBe(
      true,
    )
    expect(
      getBOMidCheckAtPrice(book(0.45, 0.55, 0.5), OrderDirections.Short, 0.35).farFromMid,
    ).toBe(true)
  })

  it('flags any limit when the book reports no mid', () => {
    expect(getBOMidCheckAtPrice(book(0.01, 0, 0), OrderDirections.Long, 0.5).farFromMid).toBe(true)
    expect(getBOMidCheckAtPrice(undefined, OrderDirections.Long, 0.5).farFromMid).toBe(true)
  })

  it('matches the touch check when given the touch price', () => {
    const stats = book(0.01, 0.99, 0.5)
    for (const direction of [OrderDirections.Long, OrderDirections.Short]) {
      for (const side of ['buy', 'sell'] as const) {
        const touch = getBOMidCheck(stats, direction, side)
        expect(getBOMidCheckAtPrice(stats, direction, touch.bestPrice)).toEqual(touch)
      }
    }
  })
})

describe('buildBORowOrder', () => {
  it('marks a one-tap buy whose only ask sits far above the mid', () => {
    const order = buildBORowOrder({
      quoteAmount: 10,
      priceTolerance: 2,
      stats: { best_bid_price: 0.01, best_ask_price: 0.99, mid_price: 0.5 } as WsBOMarketStats,
      direction: OrderDirections.Long,
      market: { price_decimals: 2, size_decimals: 4 },
      isMarketDataLive: true,
    })
    expect(order?.displayPrice).toBe(0.99)
    expect(order?.midPrice).toBe(0.5)
    expect(order?.farFromMid).toBe(true)
  })

  it('builds nothing while market data is not live', () => {
    const build = (isMarketDataLive: boolean) =>
      buildBORowOrder({
        quoteAmount: 10,
        priceTolerance: 2,
        stats: { best_bid_price: 0.49, best_ask_price: 0.51, mid_price: 0.5 } as WsBOMarketStats,
        direction: OrderDirections.Long,
        market: { price_decimals: 2, size_decimals: 4 },
        isMarketDataLive,
      })

    expect(build(true)).not.toBeNull()
    expect(build(false)).toBeNull()
  })
})
