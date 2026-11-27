import { OrderTypeEnum } from 'zklighter-perps'
import { describe, expect, it } from 'vitest'

import type { OrderBookDetail } from '../../types/compatibility'
import type { TimeInForce } from '../place-order/utils'
import { selectIsPlaceOrderSizeInvalid, selectPlaceOrderSizeErrorText } from './validation'

const market = {
  display_price_decimals: 2,
  display_size_decimals: 4,
  market_type: 'perp',
  min_base_amount: '0.01',
  min_quote_amount: '10',
  multiplier: '1',
  order_quote_limit: '100000',
  size_decimals: 4,
  symbol: 'ETH',
} as OrderBookDetail

type SizeErrorParams = {
  isAdvancedTWAP?: boolean
  isScale?: boolean
  scaleOrders?: { size: number; price: number }[]
  timeInForce?: TimeInForce
  orderTypeEnum?: OrderTypeEnum
  baseAmount?: number
  orderPrice?: number
  pinnedValueInputValue?: string
}

const getSizeError = ({
  isAdvancedTWAP = false,
  isScale = false,
  scaleOrders = [],
  timeInForce = 'gtd',
  orderTypeEnum = OrderTypeEnum.Limit,
  baseAmount = 1,
  orderPrice = 1000,
  pinnedValueInputValue = String(baseAmount),
}: SizeErrorParams) =>
  selectPlaceOrderSizeErrorText.resultFunc(
    isAdvancedTWAP,
    isScale,
    scaleOrders,
    timeInForce,
    orderTypeEnum,
    baseAmount,
    orderPrice,
    pinnedValueInputValue,
    market,
  )

const maximumError = {
  key: 'maximum_order_size_warning',
  values: { amount: '$100,000.00' },
}
const scaleMaximumError = {
  key: 'maximum_order_size_warning_scale',
  values: { maxValue: '$100,000.00' },
}
const minimumError = {
  key: 'min_order_size_warning',
  values: { minValue: '$10.00', minSize: '0.0100 ETH' },
}
const scaleMinimumError = {
  key: 'minimum_order_size_warning_scale',
  values: { minValue: '$10.00', minSize: '0.0100 ETH' },
}

describe('selectPlaceOrderSizeErrorText', () => {
  it('returns no error for a valid order', () => {
    expect(getSizeError({})).toBeNull()
  })

  it('skips every size validation for advanced TWAP', () => {
    expect(
      getSizeError({
        isAdvancedTWAP: true,
        orderTypeEnum: OrderTypeEnum.Twap,
        baseAmount: 1000,
        pinnedValueInputValue: '1000',
      }),
    ).toBeNull()
    expect(
      getSizeError({ isAdvancedTWAP: true, baseAmount: 0, pinnedValueInputValue: '0.00001' }),
    ).toBeNull()
  })

  describe('limits', () => {
    it('validates the minimum base and quote amounts', () => {
      expect(getSizeError({ baseAmount: 0.001 })).toEqual(minimumError)
      expect(getSizeError({ baseAmount: 0.01, orderPrice: 500 })).toEqual(minimumError)
    })

    it('skips the minimum for IOC limits', () => {
      expect(getSizeError({ timeInForce: 'ioc', baseAmount: 0.001 })).toBeNull()
      expect(getSizeError({ timeInForce: 'ioc', baseAmount: 100, orderPrice: 1000.01 })).toEqual(
        maximumError,
      )
    })

    it('ignores a stale IOC time in force on SL/TP limits', () => {
      expect(
        getSizeError({
          timeInForce: 'ioc',
          orderTypeEnum: OrderTypeEnum.StopLossLimit,
          baseAmount: 0.001,
        }),
      ).toEqual(minimumError)
    })

    it('validates the maximum after size rounding', () => {
      expect(getSizeError({ baseAmount: 33.3334, orderPrice: 3000 })).toEqual(maximumError)
    })

    it('validates SL/TP limits against the minimum and maximum', () => {
      expect(
        getSizeError({
          orderTypeEnum: OrderTypeEnum.StopLossLimit,
          baseAmount: 100,
          orderPrice: 1000.01,
        }),
      ).toEqual(maximumError)
      expect(
        getSizeError({
          orderTypeEnum: OrderTypeEnum.TakeProfitLimit,
          baseAmount: 0.01,
          orderPrice: 500,
        }),
      ).toEqual(minimumError)
    })
  })

  describe('market, SL/TP market and TWAP orders', () => {
    it('validates the maximum only', () => {
      expect(
        getSizeError({ orderTypeEnum: OrderTypeEnum.Market, baseAmount: 100, orderPrice: 1000.01 }),
      ).toEqual(maximumError)
      expect(getSizeError({ orderTypeEnum: OrderTypeEnum.Market, baseAmount: 0.001 })).toBeNull()
    })

    it('validates the maximum for SL/TP market and TWAP orders', () => {
      for (const orderTypeEnum of [
        OrderTypeEnum.StopLoss,
        OrderTypeEnum.TakeProfit,
        OrderTypeEnum.Twap,
      ]) {
        expect(getSizeError({ orderTypeEnum, baseAmount: 100, orderPrice: 1000.01 })).toEqual(
          maximumError,
        )
        expect(getSizeError({ orderTypeEnum, baseAmount: 0.001 })).toBeNull()
      }
    })
  })

  describe('scale orders', () => {
    const validScaleOrder = { size: 1, price: 1000 }
    const validScaleOrders = [validScaleOrder, { size: 1, price: 1001 }]

    it('validates the maximum for each scale order', () => {
      expect(
        getSizeError({
          isScale: true,
          scaleOrders: [validScaleOrder, { size: 100, price: 1000.01 }],
          baseAmount: 101,
        }),
      ).toEqual(scaleMaximumError)
    })

    it('validates the minimum for each resting scale order', () => {
      const scaleOrders = [validScaleOrder, { size: 0.005, price: 1000 }]

      expect(getSizeError({ isScale: true, scaleOrders })).toEqual(scaleMinimumError)
      expect(getSizeError({ isScale: true, timeInForce: 'ioc', scaleOrders })).toBeNull()
    })

    it('validates a later maximum when IOC skips an earlier minimum', () => {
      expect(
        getSizeError({
          isScale: true,
          timeInForce: 'ioc',
          scaleOrders: [
            { size: 0.005, price: 1000 },
            { size: 100, price: 1000.01 },
          ],
        }),
      ).toEqual(scaleMaximumError)
    })

    it('does not validate the aggregate amount as a resting limit', () => {
      expect(
        getSizeError({
          isScale: true,
          scaleOrders: validScaleOrders,
          baseAmount: 100,
          orderPrice: 1200,
        }),
      ).toBeNull()
    })
  })

  describe('empty or rounded-to-zero input', () => {
    it('returns no size error text for an empty input', () => {
      expect(getSizeError({ baseAmount: 0, pinnedValueInputValue: '' })).toBeNull()
    })

    it('returns no error for an empty input before checking the maximum', () => {
      expect(
        getSizeError({
          isScale: true,
          scaleOrders: [{ size: 100, price: 1000.01 }],
          pinnedValueInputValue: '0',
        }),
      ).toBeNull()
      expect(
        getSizeError({
          orderTypeEnum: OrderTypeEnum.Market,
          baseAmount: 100,
          orderPrice: 1000.01,
          pinnedValueInputValue: '',
        }),
      ).toBeNull()
    })

    it('returns a zero size error when a filled input rounds to zero', () => {
      expect(
        getSizeError({
          orderTypeEnum: OrderTypeEnum.Market,
          baseAmount: 0,
          pinnedValueInputValue: '0.00001',
        }),
      ).toEqual({ key: 'order_size_zero_warning' })
    })
  })
})

describe('selectIsPlaceOrderSizeInvalid', () => {
  it('is invalid for an empty input or a size error', () => {
    expect(selectIsPlaceOrderSizeInvalid.resultFunc(true, null)).toBe(true)
    expect(
      selectIsPlaceOrderSizeInvalid.resultFunc(false, { key: 'order_size_zero_warning' }),
    ).toBe(true)
    expect(selectIsPlaceOrderSizeInvalid.resultFunc(false, null)).toBe(false)
  })
})
