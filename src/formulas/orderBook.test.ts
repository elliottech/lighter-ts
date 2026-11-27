import { describe, expect, it } from 'vitest'

import { OrderType } from '../types/order'

import { computeVeryHighSlippage } from './orderBook'

describe('computeVeryHighSlippage', () => {
  it('flags a market order whose estimated slippage is above 5%', () => {
    expect(computeVeryHighSlippage(OrderType.Market, 5.01)).toBe(true)
    expect(computeVeryHighSlippage(OrderType.Market, 5)).toBe(false)
  })

  it('never flags a non-market order', () => {
    expect(computeVeryHighSlippage(OrderType.Limit, 50)).toBe(false)
    expect(computeVeryHighSlippage(OrderType.Twap, 50)).toBe(false)
  })
})
