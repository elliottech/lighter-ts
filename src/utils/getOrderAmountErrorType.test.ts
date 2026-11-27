import { OrderTimeInForceEnum, OrderTypeEnum } from 'zklighter-perps'
import { describe, expect, it } from 'vitest'

import type { OrderBookDetail } from '../types/compatibility'
import { getOrderAmountErrorType } from './getOrderAmountErrorType'

const market = {
  display_price_decimals: 2,
  display_size_decimals: 4,
  market_type: 'perp',
  min_base_amount: '0.01',
  min_quote_amount: '10',
  multiplier: '1',
  order_quote_limit: '100000',
  symbol: 'ETH',
} as OrderBookDetail

describe('getOrderAmountErrorType', () => {
  it('returns minimum for a zero base amount', () => {
    expect(
      getOrderAmountErrorType(0, 0, market, OrderTypeEnum.Limit, OrderTimeInForceEnum.GoodTillTime),
    ).toEqual('minimum')
  })

  it('returns minimum below the minimum base amount', () => {
    expect(
      getOrderAmountErrorType(
        0.005,
        1000,
        market,
        OrderTypeEnum.Limit,
        OrderTimeInForceEnum.GoodTillTime,
      ),
    ).toEqual('minimum')
  })

  it('returns minimum below the minimum quote amount', () => {
    expect(
      getOrderAmountErrorType(
        0.01,
        500,
        market,
        OrderTypeEnum.Limit,
        OrderTimeInForceEnum.GoodTillTime,
      ),
    ).toEqual('minimum')
  })

  it('returns maximum above the maximum quote amount', () => {
    expect(
      getOrderAmountErrorType(
        100,
        1000.01,
        market,
        OrderTypeEnum.Limit,
        OrderTimeInForceEnum.GoodTillTime,
      ),
    ).toEqual('maximum')
  })

  it('returns null when the amount is within the allowed range', () => {
    expect(
      getOrderAmountErrorType(
        0.01,
        1000,
        market,
        OrderTypeEnum.Limit,
        OrderTimeInForceEnum.GoodTillTime,
      ),
    ).toBeNull()
  })

  it('validates SL/TP limit orders with a base amount', () => {
    expect(
      getOrderAmountErrorType(
        0.01,
        500,
        market,
        OrderTypeEnum.StopLossLimit,
        OrderTimeInForceEnum.GoodTillTime,
      ),
    ).toEqual('minimum')
    expect(
      getOrderAmountErrorType(
        0.005,
        5000,
        market,
        OrderTypeEnum.TakeProfitLimit,
        OrderTimeInForceEnum.GoodTillTime,
      ),
    ).toEqual('minimum')
  })

  it('validates the maximum quote amount for every order type', () => {
    for (const orderTypeEnum of [
      OrderTypeEnum.Limit,
      OrderTypeEnum.Market,
      OrderTypeEnum.StopLoss,
      OrderTypeEnum.StopLossLimit,
      OrderTypeEnum.TakeProfit,
      OrderTypeEnum.TakeProfitLimit,
      OrderTypeEnum.Twap,
    ]) {
      expect(
        getOrderAmountErrorType(
          100,
          1000.01,
          market,
          orderTypeEnum,
          OrderTimeInForceEnum.GoodTillTime,
        ),
      ).toEqual('maximum')
    }
  })

  it('skips the minimum for market, SL/TP market and TWAP orders', () => {
    for (const orderTypeEnum of [
      OrderTypeEnum.Market,
      OrderTypeEnum.StopLoss,
      OrderTypeEnum.TakeProfit,
      OrderTypeEnum.Twap,
    ]) {
      expect(
        getOrderAmountErrorType(
          0.005,
          1000,
          market,
          orderTypeEnum,
          OrderTimeInForceEnum.GoodTillTime,
        ),
      ).toBeNull()
      expect(
        getOrderAmountErrorType(
          0.01,
          500,
          market,
          orderTypeEnum,
          OrderTimeInForceEnum.GoodTillTime,
        ),
      ).toBeNull()
    }
  })

  it('skips the minimum for position tied SL/TP limit orders', () => {
    for (const orderTypeEnum of [OrderTypeEnum.StopLossLimit, OrderTypeEnum.TakeProfitLimit]) {
      expect(
        getOrderAmountErrorType(0, 500, market, orderTypeEnum, OrderTimeInForceEnum.GoodTillTime),
      ).toBeNull()
    }
  })

  it('skips the minimum for IOC orders', () => {
    expect(
      getOrderAmountErrorType(
        0.005,
        1000,
        market,
        OrderTypeEnum.Limit,
        OrderTimeInForceEnum.ImmediateOrCancel,
      ),
    ).toBeNull()
    expect(
      getOrderAmountErrorType(
        100,
        1000.01,
        market,
        OrderTypeEnum.Limit,
        OrderTimeInForceEnum.ImmediateOrCancel,
      ),
    ).toEqual('maximum')
  })
})
