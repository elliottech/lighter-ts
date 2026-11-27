import { describe, expect, it } from 'vitest'

import { getPaidActionFees } from './getPaidFees'

import {
  INTEGRATOR_APPROVAL_TTL_MS,
  PAID_ACTION_FEE_TICKS,
  type PaidActionFeeConfig,
  arePaidActionFeesEnabled,
  getPaidActionIntegratorFees,
  isApprovalExpiryValid,
  isFreePlanTier,
  isValidLighterIntegratorApproval,
} from './paidActionFees'

// Mirrors the staging SystemConfig shape
const CONFIG: PaidActionFeeConfig = {
  fee_collector_account_index: 18,
  max_integrator_perps_taker_fee: 10,
  max_integrator_perps_maker_fee: 10,
  max_integrator_spot_taker_fee: 10000,
  max_integrator_spot_maker_fee: 20,
}

const DISABLED_CONFIG: PaidActionFeeConfig = {
  ...CONFIG,
  fee_collector_account_index: 0,
}

const approval = (
  overrides: Partial<Parameters<typeof isValidLighterIntegratorApproval>[0]> = {},
) => ({
  account_index: CONFIG.fee_collector_account_index,
  name: 'Lighter',
  max_perps_taker_fee: CONFIG.max_integrator_perps_taker_fee,
  max_perps_maker_fee: CONFIG.max_integrator_perps_maker_fee,
  max_spot_taker_fee: CONFIG.max_integrator_spot_taker_fee,
  max_spot_maker_fee: CONFIG.max_integrator_spot_maker_fee,
  approval_expiry: Date.now() + INTEGRATOR_APPROVAL_TTL_MS,
  ...overrides,
})

describe('getPaidActionFees', () => {
  it.each([
    [false, false, false, true],
    [false, true, false, true],
    [true, false, false, false],
    [true, false, true, false],
    [true, true, false, false],
    [true, true, true, true],
  ])('handles blocked=%s QR=%s approved=%s', (isBlocked, isQRLogin, isApproved, charges) => {
    expect(getPaidActionFees('standard', CONFIG, { isBlocked, isQRLogin, isApproved })).toEqual(
      charges ? getPaidActionIntegratorFees('standard', CONFIG) : undefined,
    )
  })

  it('does not charge unloaded or paid tiers, or a disabled collector', () => {
    const approvalState = { isBlocked: false, isQRLogin: false, isApproved: false }
    for (const tier of [null, 'plus', 'premium'] as const) {
      expect(getPaidActionFees(tier, CONFIG, approvalState)).toBeUndefined()
    }
    expect(getPaidActionFees('standard', DISABLED_CONFIG, approvalState)).toBeUndefined()
  })
})

describe('isFreePlanTier', () => {
  it('treats an unloaded tier as free, like the rest of the app', () => {
    expect(isFreePlanTier(null)).toBe(true)
  })

  it('treats standard as free and paid plans as not free', () => {
    expect(isFreePlanTier('standard')).toBe(true)
    expect(isFreePlanTier('plus')).toBe(false)
    expect(isFreePlanTier('premium')).toBe(false)
  })
})

describe('getPaidActionIntegratorFees', () => {
  it('charges 1 bp to free and not-yet-loaded tiers', () => {
    const config = {
      ...CONFIG,
      max_integrator_perps_taker_fee: 1000,
      max_integrator_perps_maker_fee: 1000,
    }
    for (const tier of ['standard', null] as const) {
      expect(getPaidActionIntegratorFees(tier, config)).toEqual({
        accountIndex: 18,
        takerFee: PAID_ACTION_FEE_TICKS,
        makerFee: PAID_ACTION_FEE_TICKS,
      })
    }
  })

  it('never exceeds the caps the approval signed', () => {
    expect(getPaidActionIntegratorFees('standard', CONFIG)).toEqual({
      accountIndex: 18,
      takerFee: CONFIG.max_integrator_perps_taker_fee,
      makerFee: CONFIG.max_integrator_perps_maker_fee,
    })
  })

  it('never charges a paid plan', () => {
    expect(getPaidActionIntegratorFees('plus', CONFIG)).toBeUndefined()
    expect(getPaidActionIntegratorFees('premium', CONFIG)).toBeUndefined()
  })

  it('charges nobody when the backend reports no collector', () => {
    expect(arePaidActionFeesEnabled(DISABLED_CONFIG)).toBe(false)
    expect(getPaidActionIntegratorFees('standard', DISABLED_CONFIG)).toBeUndefined()
    expect(getPaidActionIntegratorFees(null, DISABLED_CONFIG)).toBeUndefined()
  })
})

describe('isApprovalExpiryValid', () => {
  it('spends an approval a buffer before it actually lapses', () => {
    expect(isApprovalExpiryValid(Date.now() + INTEGRATOR_APPROVAL_TTL_MS)).toBe(true)
    expect(isApprovalExpiryValid(Date.now() + 1000)).toBe(false)
    expect(isApprovalExpiryValid(Date.now() - 1000)).toBe(false)
  })

  it('ignores an approval that outlives what this client would sign', () => {
    expect(isApprovalExpiryValid(Date.now() + INTEGRATOR_APPROVAL_TTL_MS * 2)).toBe(false)
  })
})

describe('isValidLighterIntegratorApproval', () => {
  it('accepts an approval matching the backend terms', () => {
    expect(isValidLighterIntegratorApproval(approval(), CONFIG)).toBe(true)
  })

  it('rejects an approval for a different collector', () => {
    expect(isValidLighterIntegratorApproval(approval({ account_index: 37 }), CONFIG)).toBe(false)
  })

  it('rejects an approval below the current caps', () => {
    expect(
      isValidLighterIntegratorApproval(
        approval({
          max_perps_taker_fee: CONFIG.max_integrator_perps_taker_fee - 1,
        }),
        CONFIG,
      ),
    ).toBe(false)
  })

  it('rejects everything while fee collection is off', () => {
    expect(isValidLighterIntegratorApproval(approval(), DISABLED_CONFIG)).toBe(false)
  })
})
