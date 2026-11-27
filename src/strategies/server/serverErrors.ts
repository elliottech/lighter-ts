import type { Clock } from '../engine/types'
import { formatUnknownError } from '../engine/errors'
import type { WorkerToMain } from '../worker/protocol'
import type { StrategiesServerError } from '../wsProtocol'
import type { ServerDb, UnackedErrors } from './serverDb'

/** How many errors `connected` and each `errors` message carry at most. */
export const STRATEGIES_WS_MAX_SENT_ERRORS = 50
export const DEFAULT_MAX_ERROR_MESSAGE_LENGTH = 1000
export const DEFAULT_MAX_ERROR_STACK_LENGTH = 8000

export interface ServerErrors {
  /** Stores the error of a `sentry` event; ignores every other message. */
  record: (message: WorkerToMain) => void
  /** The latest errors not acked yet, by increasing id. */
  getUnacked: () => UnackedErrors
  ack: (lastErrorId: number) => void
  subscribe: (listener: (error: StrategiesServerError) => void) => () => void
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const toStrings = (value: unknown): Record<string, string> | undefined => {
  if (!isObject(value)) return undefined
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]))
}

// The worker's errors arrive as JSON, so they are `{ name, message, stack }` and no Error.
const describeError = (
  error: unknown,
): Pick<StrategiesServerError, 'name' | 'message' | 'stack'> => {
  if (!isObject(error)) return { name: 'Error', message: formatUnknownError(error) }
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : formatUnknownError(error),
    stack: typeof error.stack === 'string' ? error.stack : undefined,
  }
}

const truncateError = (
  { name, message, stack }: Pick<StrategiesServerError, 'name' | 'message' | 'stack'>,
  maxMessageLength: number,
  maxStackLength: number,
): Pick<StrategiesServerError, 'name' | 'message' | 'stack'> => ({
  name,
  message: message.slice(0, maxMessageLength),
  stack: stack?.slice(0, maxStackLength),
})

export const createServerErrors = ({
  db,
  clock,
  version,
  maxMessageLength,
  maxStackLength,
  onStoreError,
}: {
  db: Pick<ServerDb, 'saveError' | 'readUnackedErrors' | 'ackErrors'>
  clock: Clock
  version: string | null
  /** `message` and `stack` are cut to these lengths before they are stored. */
  maxMessageLength: number
  maxStackLength: number
  /** A failed write, which must not be captured again. */
  onStoreError: (error: unknown) => void
}): ServerErrors => {
  const listeners = new Set<(error: StrategiesServerError) => void>()
  return {
    record: (message) => {
      if (message.kind !== 'event' || message.event.type !== 'sentry') return
      const { error, tags, debugIds } = message.event
      let stored: StrategiesServerError
      try {
        stored = db.saveError({
          timestamp: clock.now(),
          ...truncateError(describeError(error), maxMessageLength, maxStackLength),
          tags: toStrings(tags) ?? {},
          debugIds: toStrings(debugIds),
          strategyId: message.id || undefined,
          version,
        })
      } catch (storeError) {
        onStoreError(storeError)
        return
      }
      for (const listener of listeners) listener(stored)
    },
    getUnacked: () => db.readUnackedErrors(STRATEGIES_WS_MAX_SENT_ERRORS),
    ack: (lastErrorId) => db.ackErrors(lastErrorId),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
