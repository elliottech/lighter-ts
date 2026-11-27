import { ApiError, type CaptureException } from '../..'
import { type WorkerToMain } from './protocol'
import { RATE_LIMIT_ERROR_CODE, formatUnknownError } from '../engine/errors'

let post: (message: WorkerToMain) => void = () => {}

export const configureWorkerExceptions = (next: (message: WorkerToMain) => void): void => {
  post = next
}

const RATE_LIMIT_REPORT_INTERVAL_MS = 30 * 60_000

let lastRateLimitReportAt: number | null = null

const isRateLimitError = (error: unknown): boolean =>
  (error instanceof ApiError && error.code === RATE_LIMIT_ERROR_CODE) ||
  (error instanceof Error && error.message === 'Request failed with status 429')

const shouldSkipRateLimitReport = (error: unknown): boolean => {
  if (!isRateLimitError(error)) return false
  const now = Date.now()
  if (
    lastRateLimitReportAt !== null &&
    now - lastRateLimitReportAt < RATE_LIMIT_REPORT_INTERVAL_MS
  ) {
    return true
  }
  lastRateLimitReportAt = now
  return false
}

const sentryGlobal = globalThis as { _sentryDebugIds?: Record<string, string> }

type WorkerExceptionHint = { id?: string; tags?: unknown } | null | undefined

const getTags = (tags: unknown): Record<string, string> | undefined => {
  if (!tags || typeof tags !== 'object') return undefined
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key, String(value)]))
}

const toCloneableError = (error: unknown): Error => {
  const cloneable = new Error(formatUnknownError(error))
  if (error instanceof Error && error.stack) cloneable.stack = error.stack
  return cloneable
}

export const captureWorkerException: CaptureException = (error, hint) => {
  if (shouldSkipRateLimitReport(error)) return ''
  const { id, tags } = (hint as WorkerExceptionHint) ?? {}
  post({
    kind: 'event',
    id: id ?? '',
    event: {
      type: 'sentry',
      error: toCloneableError(error),
      tags: { feature: 'strategy-worker', ...getTags(tags) },
      debugIds: sentryGlobal._sentryDebugIds,
    },
  })
  return ''
}
