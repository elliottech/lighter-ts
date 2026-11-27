import { describe, expect, it } from 'vitest'
import { AccountBinaryOptionsPositionSignEnum } from 'zklighter-perps'

import { OrderType } from '../types/order'
import type { AssetBalance, BOPosition, OrderbookItem } from '../store/types'
import { USDC_ASSET_ID } from '../store/orderbook/selectors'
import type { BOTimeInForce } from '../store/bo/createBOSlice'
import {
  computeBOAvailableToTradeLimit,
  computeBOMatchInfo,
  computeBOOrderPayoff,
  computeBOOrderPrice,
  computeBOSellProceeds,
  computeBOSellableShares,
  getBOOrderAmountErrorType,
  computeBOTooMuchSlippage,
  computeBOWorstExecutionPrice,
} from './boOrderMargin'
import { computeShouldShowLimitPriceWarning } from './orderBook'
import { flipBOPrice } from '../utils/bo'

describe('computeBOAvailableToTradeLimit', () => {
  const usdcBalance: AssetBalance = {
    asset_id: USDC_ASSET_ID,
    margin_mode: 'enabled',
    balance: 0,
    margin_balance: 100,
    locked_balance: 0,
    available_balance: 0,
    available_margin_balance: 100,
  }

  it.each([
    [100, 75],
    [70, 75],
  ])(
    'caps unified USDC transfer value %s without double subtracting the reserve',
    (value, expected) => {
      expect(
        computeBOAvailableToTradeLimit(
          { [USDC_ASSET_ID]: value },
          5,
          { [USDC_ASSET_ID]: usdcBalance },
          30,
        ),
      ).toBe(expected)
    },
  )

  it('keeps the non-margin available balance unchanged', () => {
    expect(
      computeBOAvailableToTradeLimit(
        { [USDC_ASSET_ID]: 70 },
        5,
        { [USDC_ASSET_ID]: { ...usdcBalance, margin_mode: 'disabled' } },
        30,
      ),
    ).toBe(75)
  })

  it('returns null when the reserve is unknown', () => {
    expect(
      computeBOAvailableToTradeLimit(
        { [USDC_ASSET_ID]: 100 },
        5,
        { [USDC_ASSET_ID]: usdcBalance },
        null,
      ),
    ).toBeNull()
  })
})

describe('computeBOOrderPrice', () => {
  it('uses the estimated fill for a market order', () => {
    expect(computeBOOrderPrice(OrderType.Market, 0.4, '40', 0.5, { estPrice: 0.55 })).toBe(0.55)
  })

  it('uses the limit price, or the mid when the input is empty, clamped to a tick', () => {
    expect(computeBOOrderPrice(OrderType.Limit, 0.4, '40', 0.5, undefined)).toBe(0.4)
    expect(computeBOOrderPrice(OrderType.Limit, 0, '', 0.5, undefined)).toBe(0.5)
    expect(computeBOOrderPrice(OrderType.Limit, 0, '0', 0.5, undefined)).toBe(0.01)
  })
})

describe('computeBOOrderPayoff', () => {
  it('pays one per share and returns profit and ROI after fees', () => {
    const payoff = computeBOOrderPayoff(100, 40, 1)
    expect(payoff.payout).toBe(100)
    expect(payoff.profit).toBe(59)
    expect(payoff.roi).toBeCloseTo((59 / 41) * 100)
  })

  it('has no ROI without a cost', () => {
    expect(computeBOOrderPayoff(0, 0, 0).roi).toBe(0)
  })
})

describe('computeBOSellableShares', () => {
  const up = { sign: AccountBinaryOptionsPositionSignEnum.Yes, size: 10 } as BOPosition
  const down = { sign: AccountBinaryOptionsPositionSignEnum.No, size: 10 } as BOPosition

  it('sells only the shares held in that outcome', () => {
    expect(computeBOSellableShares(false, up)).toBe(10)
    expect(computeBOSellableShares(true, down)).toBe(10)
    expect(computeBOSellableShares(true, up)).toBe(0)
    expect(computeBOSellableShares(false, down)).toBe(0)
    expect(computeBOSellableShares(false, undefined)).toBe(0)
  })
})

describe('computeBOSellProceeds', () => {
  it('pays the sale price per share after fees', () => {
    expect(computeBOSellProceeds(10, 0.6, 0.12)).toBeCloseTo(5.88)
    expect(computeBOSellProceeds(0, 0.6, 0)).toBe(0)
    expect(computeBOSellProceeds(1, 0.01, 0.05)).toBe(0)
  })
})

const market = {
  price_decimals: 2,
  size_decimals: 4,
  order_quote_limit: '1000',
  min_base_amount: '5',
}

interface Order {
  isShort: boolean
  orderType: OrderType
  timeInForce: BOTimeInForce
  baseAmount: number
  price: number
  sidedLevels: OrderbookItem[]
  priceToleranceCents: number
}

const defaultLevels = [
  { price: 0.5, size: 5 },
  { price: 0.6, size: 20 },
] as OrderbookItem[]

const order = (overrides: Partial<Order> = {}): Order => ({
  isShort: false,
  orderType: OrderType.Market,
  timeInForce: 'gtt',
  baseAmount: 10,
  price: 0.5,
  sidedLevels: defaultLevels,
  priceToleranceCents: 2,
  ...overrides,
})

const worstPrice = (o: Order) =>
  computeBOWorstExecutionPrice(market, o.sidedLevels[0]?.price, o.priceToleranceCents)

const sizeError = (overrides: Partial<Order>) => {
  const o = order(overrides)
  const worst = worstPrice(o)
  const sizedPrice = o.orderType === OrderType.Market && worst !== null ? worst : o.price
  return getBOOrderAmountErrorType(
    o.baseAmount,
    o.isShort ? flipBOPrice(sizedPrice) : sizedPrice,
    market,
    o.orderType,
    o.timeInForce,
  )
}

describe('BO order validation', () => {
  it('checks a market order against its signed price, touch plus tolerance', () => {
    const levels = [{ price: 0.97, size: 2000 }] as OrderbookItem[]
    expect(sizeError({ baseAmount: 1020, sidedLevels: levels })).toBe('maximum')
  })

  it('flags an order above the quote limit, on the costlier side', () => {
    expect(sizeError({ baseAmount: 3000, isShort: true, price: 0.2 })).toBe('maximum')
  })

  it('flags a limit order under the minimum share amount', () => {
    expect(sizeError({ orderType: OrderType.Limit, baseAmount: 4, price: 0.01 })).toBe('minimum')
    expect(sizeError({ orderType: OrderType.Limit, baseAmount: 5, price: 0.01 })).toBeNull()
  })

  it('flags a market order whose average price is above the worst execution price', () => {
    expect(computeBOTooMuchSlippage(OrderType.Market, 0.53, 0.52)).toBe(true)
    expect(computeBOTooMuchSlippage(OrderType.Market, 0.52, 0.52)).toBe(false)
    expect(computeBOTooMuchSlippage(OrderType.Limit, 0.53, 0.52)).toBe(false)
    expect(computeBOTooMuchSlippage(OrderType.Market, 0.53, null)).toBe(false)
  })

  it('accepts a market order filled within the tolerance', () => {
    expect(sizeError({ baseAmount: 5 })).toBeNull()
  })

  it('warns when a limit price would cross the touch', () => {
    const book = { asks: defaultLevels, bids: defaultLevels }
    expect(computeShouldShowLimitPriceWarning(OrderType.Limit, 'gtt', false, 0.55, 1, book)).toBe(
      true,
    )
    expect(computeShouldShowLimitPriceWarning(OrderType.Limit, 'ioc', false, 0.55, 1, book)).toBe(
      false,
    )
  })
})

describe('computeBOMatchInfo percentage', () => {
  it('sizes a full slider to the whole amount on the limit and market paths', () => {
    expect(
      computeBOMatchInfo(OrderType.Limit, 'percentage', '100', 0.5, 0.5, [], 0.0014, 0),
    ).toMatchObject({
      baseAmount: 0.0014,
    })
    expect(
      computeBOMatchInfo(
        OrderType.Market,
        'percentage',
        '100',
        0,
        0.5,
        [{ price: 0.5, size: 0.0014 }],
        0.0014,
        0.0014,
      ),
    ).toMatchObject({ baseAmountInputValue: '0.0014', baseAmount: 0.0014 })
  })
})
