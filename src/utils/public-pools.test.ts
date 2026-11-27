import { describe, expect, it } from 'vitest'

import { getRemainingLlpDepositLimit, getYourPublicPoolStats } from './public-pools'

const depositorShare = {
  public_pool_index: 7,
  shares_amount: 20,
  principal_amount: 150,
  entry_timestamp: 0,
}

describe('getYourPublicPoolStats', () => {
  it('preserves depositor stats when operator shares are also present', () => {
    expect(getYourPublicPoolStats([depositorShare], 7, 1000, 100, 20)).toEqual({
      yourDeposits: 150,
      yourEquity: 200,
      yourReturns: 50,
    })
  })

  it('uses operator shares when depositor shares are absent', () => {
    expect(getYourPublicPoolStats([], 7, 1000, 100, 10)).toEqual({
      yourDeposits: null,
      yourEquity: 100,
      yourReturns: 100,
    })
  })

  it('returns deposits while equity is unavailable', () => {
    expect(getYourPublicPoolStats([depositorShare], 7, null, 100, 20)).toEqual({
      yourDeposits: 150,
      yourEquity: null,
      yourReturns: null,
    })
  })
})

describe('getRemainingLlpDepositLimit', () => {
  it('subtracts the current deposit from the limit', () => {
    expect(getRemainingLlpDepositLimit('200', [depositorShare], 7)).toBe(50)
  })

  it('returns the full limit without a deposit in the pool', () => {
    expect(getRemainingLlpDepositLimit('200', [depositorShare], 8)).toBe(200)
  })

  it('never goes below zero', () => {
    expect(getRemainingLlpDepositLimit('100', [depositorShare], 7)).toBe(0)
    expect(getRemainingLlpDepositLimit('0', [], 7)).toBe(0)
  })

  it('returns null while the limit is unknown', () => {
    expect(getRemainingLlpDepositLimit(undefined, [depositorShare], 7)).toBeNull()
  })
})
