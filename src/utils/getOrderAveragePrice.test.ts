import { describe, expect, it } from 'vitest'

import { getOrderAveragePrice } from './getOrderAveragePrice'

describe('getOrderAveragePrice', () => {
  it('divides the filled quote by the filled base', () => {
    expect(
      getOrderAveragePrice({ filled_base_amount: 50, filled_quote_amount: 32.45 }),
    ).toBeCloseTo(0.649)
  })

  it('returns null when nothing filled', () => {
    expect(getOrderAveragePrice({ filled_base_amount: 0, filled_quote_amount: 0 })).toBeNull()
  })
})
