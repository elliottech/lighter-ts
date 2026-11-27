import { type PaidActionFeeConfig, getPaidActionIntegratorFees } from './paidActionFees'
import type { UserTier } from '../types/user-tiers'

interface PaidActionFeeApproval {
  isBlocked: boolean
  isQRLogin: boolean
  isApproved: boolean
}

/**
 * L1-only logins cannot sign the integrator approval and are never charged.
 * QR logins are charged only when an approval is already valid.
 */
const isPaidActionFeeBlocked = ({ isBlocked, isQRLogin, isApproved }: PaidActionFeeApproval) => {
  if (!isBlocked) {
    return false
  }

  if (!isQRLogin) {
    return true
  }

  return !isApproved
}

/**
 * The integrator fees a paid action (RFQ, Chase, Advanced TWAP, Iceberg)
 * attaches for this account, or undefined. Only a *known* Standard tier pays:
 * an unloaded tier is not billed as Standard, so a Plus/Premium account can
 * never be charged while its tier is still resolving. Single source for every
 * attach site.
 */
export const getPaidActionFees = (
  userTier: UserTier,
  config: PaidActionFeeConfig,
  approval: PaidActionFeeApproval,
) =>
  userTier === 'standard' && !isPaidActionFeeBlocked(approval)
    ? getPaidActionIntegratorFees(userTier, config)
    : undefined
