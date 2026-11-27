import type { MarketMeta } from './engine/types'
import type { WsTrade } from '..'
import { describe, expect, it } from 'vitest'

import { sumOrderTradeVolumes } from './orderTradeVolumes'

const trade = (size: number, is_maker_ask: boolean): WsTrade => ({ size, is_maker_ask }) as WsTrade

const market = { size_decimals: 4 } as MarketMeta

describe('sumOrderTradeVolumes', () => {
  it('credits maker volume when the order side was the maker', () => {
    // Ask order: maker exactly on trades where the ask side was the maker.
    expect(sumOrderTradeVolumes([trade(1, true), trade(2, false)], true, market)).toEqual({
      makerBaseAmount: 1,
      takerBaseAmount: 2,
    })
    // Bid order: the classification flips.
    expect(sumOrderTradeVolumes([trade(1, true), trade(2, false)], false, market)).toEqual({
      makerBaseAmount: 2,
      takerBaseAmount: 1,
    })
  })

  it('rounds accumulated sizes to the market size decimals', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in raw float math.
    expect(sumOrderTradeVolumes([trade(0.1, true), trade(0.2, true)], true, market)).toEqual({
      makerBaseAmount: 0.3,
      takerBaseAmount: 0,
    })
  })

  it('returns zero volumes for no trades', () => {
    expect(sumOrderTradeVolumes([], true, market)).toEqual({
      makerBaseAmount: 0,
      takerBaseAmount: 0,
    })
  })
})
