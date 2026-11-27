import type { ApprovedIntegrator, SystemConfig } from 'zklighter-perps'

import type { IntegratorFees } from '../types/order'
import type { UserTier } from '../types/user-tiers'
import { getFeePercentage } from './fees'
import { formatPercentage } from './formatting'

// The paid-action fee (1 bp) in integrator-fee ticks
export const PAID_ACTION_FEE_TICKS = 100
export const PAID_ACTION_FEE_RATE = getFeePercentage(PAID_ACTION_FEE_TICKS)
export const PAID_ACTION_FEE_LABEL = formatPercentage(PAID_ACTION_FEE_RATE, {
  maximumFractionDigits: 4,
})

export const INTEGRATOR_APPROVAL_TTL_MS = 365 * 24 * 60 * 60 * 1000
// Re-prompt this long before the approval actually lapses, so it can't expire
// underneath a working strategy
const APPROVAL_EXPIRY_BUFFER_MS = 24 * 60 * 60 * 1000

/**
 * SystemConfig carries the collector and the max_integrator_* caps — the most
 * any integrator may charge. The approval signs the caps; orders attach our own
 * fee, bounded by them. A zero collector index means fee collection is off.
 */
export type PaidActionFeeConfig = Pick<
  SystemConfig,
  | 'fee_collector_account_index'
  | 'max_integrator_perps_taker_fee'
  | 'max_integrator_perps_maker_fee'
  | 'max_integrator_spot_taker_fee'
  | 'max_integrator_spot_maker_fee'
>

export const arePaidActionFeesEnabled = (config: PaidActionFeeConfig) =>
  (config.fee_collector_account_index ?? 0) > 0

// An unknown tier counts as free, matching the rest of the app
export const isFreePlanTier = (userTier: UserTier) => !userTier || userTier === 'standard'

/**
 * The fees a paid action (RFQ, Chase, Advanced TWAP) carries for this tier, or
 * undefined when it carries none. Never above the caps the approval signed.
 * Single source of truth for the order builders and the fee rows alike.
 */
export const getPaidActionIntegratorFees = (
  userTier: UserTier,
  config: PaidActionFeeConfig,
): IntegratorFees | undefined =>
  arePaidActionFeesEnabled(config) && isFreePlanTier(userTier)
    ? {
        accountIndex: config.fee_collector_account_index,
        takerFee: Math.min(PAID_ACTION_FEE_TICKS, config.max_integrator_perps_taker_fee),
        makerFee: Math.min(PAID_ACTION_FEE_TICKS, config.max_integrator_perps_maker_fee),
      }
    : undefined

/**
 * Approvals are treated as spent a buffer early, wherever the expiry came from,
 * and are ignored altogether once they outlive what this client would sign —
 * an approval granted under a longer-lived policy stops being honoured.
 */
export const isApprovalExpiryValid = (approvalExpiry: number) => {
  const now = Date.now()

  return (
    approvalExpiry > now + APPROVAL_EXPIRY_BUFFER_MS &&
    approvalExpiry <= now + INTEGRATOR_APPROVAL_TTL_MS
  )
}

export const isValidLighterIntegratorApproval = (
  approval: ApprovedIntegrator,
  config: PaidActionFeeConfig,
) =>
  arePaidActionFeesEnabled(config) &&
  approval.account_index === config.fee_collector_account_index &&
  isApprovalExpiryValid(approval.approval_expiry) &&
  approval.max_perps_taker_fee >= config.max_integrator_perps_taker_fee &&
  approval.max_perps_maker_fee >= config.max_integrator_perps_maker_fee &&
  approval.max_spot_taker_fee >= config.max_integrator_spot_taker_fee &&
  approval.max_spot_maker_fee >= config.max_integrator_spot_maker_fee
