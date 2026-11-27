import { describe, expect, it } from 'vitest'

import { defaultLighterFeeTiers } from '../../fallbacks/defaults'

import { selectBOFeeSchedule } from './fees'

const getSchedule = selectBOFeeSchedule.resultFunc
const feeTiers = {
  ...defaultLighterFeeTiers,
  bo_tiers: [
    { name: 'bo_0', required_volume: 0, fee_rate: 1 },
    { name: 'bo_1', required_volume: 5_000, fee_rate: 0.95 },
    { name: 'bo_2', required_volume: 25_000, fee_rate: 0.9 },
  ],
  staking_tiers: [
    { name: 'level1', required_lit_stakes: 1_000, fee_rate: 0.975 },
    { name: 'level2', required_lit_stakes: 3_000, fee_rate: 0.95 },
    { name: 'level3', required_lit_stakes: 10_000, fee_rate: 0.9 },
  ],
}

describe('selectBOFeeSchedule', () => {
  it('starts from the base tiers before account limits load', () => {
    const schedule = getSchedule(feeTiers, null, 1)

    expect(schedule.volumeTierIndex).toBe(0)
    expect(schedule.stakingTierIndex).toBe(0)
    expect(schedule.stakingTiers[0]).toEqual({ required_lit_stakes: 0, fee_rate: 1 })
  })

  it('recovers the staking tier from the account rate and its volume tier', () => {
    const schedule = getSchedule(feeTiers, 'bo_2', 0.9 * 0.95)

    expect(schedule.volumeTiers[schedule.volumeTierIndex]?.name).toBe('bo_2')
    expect(schedule.stakingTiers[schedule.stakingTierIndex]?.required_lit_stakes).toBe(3_000)
  })

  it('falls back to the base volume tier for an unknown tier name', () => {
    const schedule = getSchedule(feeTiers, 'bo_unknown', 0.9)

    expect(schedule.volumeTierIndex).toBe(0)
    expect(schedule.stakingTiers[schedule.stakingTierIndex]?.required_lit_stakes).toBe(10_000)
  })
})
