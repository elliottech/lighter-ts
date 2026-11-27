import { ApiError } from '../..'

/** Exchange rejections that no later retry can clear: the account cannot
 *  margin the order, or the reduce-only strategy has no position left. */
const NON_RETRYABLE_ORDER_ERROR_CODES = new Set([
  21732, // reduce only increases position
  21738, // invalid reduce only direction
  21739, // not enough margin to create the order
])

export const RATE_LIMIT_ERROR_CODE = 23000

export const VOLUME_QUOTA_ABORT_THRESHOLD = 5

/** Thrown by the order client once a strategy's orders were rejected for
 *  volume quota this many times in a row. */
export class VolumeQuotaExhaustedError extends Error {
  name = 'VolumeQuotaExhaustedError'

  constructor() {
    super(
      `Stopped after ${VOLUME_QUOTA_ABORT_THRESHOLD} orders in a row were rejected for not enough volume quota`,
    )
  }
}

export const isVolumeQuotaError = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.code === RATE_LIMIT_ERROR_CODE &&
  err.message.toLowerCase().includes('volume quota')

export const REDUCE_ONLY_EXHAUSTED_REASON =
  'No position left to reduce, the reduce-only order was canceled by the exchange'

/** Thrown before signing when a strategy order is priced far past the index
 *  (or mark) price on the side that costs the user. */
export class OrderPriceGuardError extends Error {
  name = 'OrderPriceGuardError'
}

export class UnconfirmedOrderError extends Error {
  name = 'UnconfirmedOrderError'
}

/** Thrown before signing when the order's client index could not be saved,
 *  so a lost worker could not find the order again. */
export class UnpersistedOrderError extends Error {
  name = 'UnpersistedOrderError'
}

export function isNonRetryableOrderError(err: unknown): boolean {
  if (
    err instanceof OrderPriceGuardError ||
    err instanceof UnconfirmedOrderError ||
    err instanceof UnpersistedOrderError ||
    err instanceof VolumeQuotaExhaustedError
  ) {
    return true
  }

  return (
    err instanceof ApiError &&
    err.code !== undefined &&
    NON_RETRYABLE_ORDER_ERROR_CODES.has(err.code)
  )
}

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message
  }

  if (typeof err === 'string') {
    return err
  }

  if (err && typeof err === 'object') {
    const maybe = err as { code?: unknown; message?: unknown; error?: unknown }

    if (typeof maybe.message === 'string' && maybe.message.length > 0) {
      return typeof maybe.code === 'number' ? `${maybe.message} (${maybe.code})` : maybe.message
    }

    if (typeof maybe.error === 'string' && maybe.error.length > 0) {
      return maybe.error
    }
  }

  return 'Something went wrong'
}
