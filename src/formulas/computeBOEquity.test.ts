import { describe, expect, it } from 'vitest'
import {
  AccountBinaryOptionsPositionSignEnum,
  BinaryOptionMarketStatsOutcomeEnum,
  BinaryOptionMarketStatsStatusEnum,
} from 'zklighter-perps'

import { computeBOEquity } from './common'

describe('computeBOEquity', () => {
  const down = { sign: AccountBinaryOptionsPositionSignEnum.No, size: 100, avg_entry_price: 0.4 }
  const up = { sign: AccountBinaryOptionsPositionSignEnum.Yes, size: 10, avg_entry_price: 0.5 }
  const activeStats = {
    last_trade_price: 0,
    outcome: BinaryOptionMarketStatsOutcomeEnum.None,
    status: BinaryOptionMarketStatsStatusEnum.Active,
  }

  it('values a position at its side of the mid', () => {
    expect(computeBOEquity({ 1: { ...activeStats, mid_price: 0.3 } }, { 1: down })).toBeCloseTo(70)
  })

  it('holds a closed window at its entry cost until it settles', () => {
    const waiting = {
      ...activeStats,
      mid_price: 0.3,
      status: BinaryOptionMarketStatsStatusEnum.WaitingForSettlement,
    }
    expect(computeBOEquity({ 1: waiting }, { 1: down })).toBeCloseTo(40)
  })

  it('values an empty book at the last trade instead of valuing Down at $1', () => {
    expect(
      computeBOEquity({ 1: { ...activeStats, mid_price: 0, last_trade_price: 0.2 } }, { 1: down }),
    ).toBeCloseTo(80)
  })

  it('keeps a position whose book has no mid next to a priced one', () => {
    expect(
      computeBOEquity(
        {
          1: { ...activeStats, mid_price: 0 },
          2: { ...activeStats, mid_price: 0.6 },
        },
        { 1: down, 2: up },
      ),
    ).toBeCloseTo(46)
  })

  it('values a settled position at its payout', () => {
    expect(
      computeBOEquity(
        {
          1: {
            ...activeStats,
            mid_price: 0,
            outcome: BinaryOptionMarketStatsOutcomeEnum.No,
            status: BinaryOptionMarketStatsStatusEnum.Settled,
          },
        },
        { 1: down },
      ),
    ).toBe(100)
  })
})
