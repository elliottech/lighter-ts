import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../engine/testUtils'
import type { StrategiesServerError } from '../wsProtocol'
import type { ServerDb } from './serverDb'
import {
  DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
  DEFAULT_MAX_ERROR_STACK_LENGTH,
  STRATEGIES_WS_MAX_SENT_ERRORS,
  createServerErrors,
} from './serverErrors'

const LIMITS = {
  maxMessageLength: DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
  maxStackLength: DEFAULT_MAX_ERROR_STACK_LENGTH,
}

const makeDb = () => {
  const errors: StrategiesServerError[] = []
  let lastAckErrorId = 0
  const db: Pick<ServerDb, 'saveError' | 'readUnackedErrors' | 'ackErrors'> = {
    saveError: vi.fn((error: Omit<StrategiesServerError, 'id'>) => {
      const saved = { ...error, id: errors.length + 1 }
      errors.push(saved)
      return saved
    }),
    readUnackedErrors: vi.fn((limit: number) => {
      const unacked = errors.filter(({ id }) => id > lastAckErrorId)
      return {
        errors: unacked.slice(-limit),
        skippedErrorsCount: Math.max(0, unacked.length - limit),
      }
    }),
    ackErrors: vi.fn((id: number) => {
      lastAckErrorId = Math.max(lastAckErrorId, id)
    }),
  }
  return { db, errors }
}

describe('createServerErrors', () => {
  it('stores a sentry event of the server or its worker and tells the subscribers', () => {
    const clock = new FakeClock()
    clock.advance(1_793_800_000_000)
    const { db } = makeDb()
    const errors = createServerErrors({
      db,
      clock,
      version: '1.0.0',
      ...LIMITS,
      onStoreError: vi.fn(),
    })
    const listener = vi.fn()
    errors.subscribe(listener)
    const thrown = new TypeError('fetch failed')

    errors.record({
      kind: 'event',
      id: 's1',
      event: {
        type: 'sentry',
        error: thrown,
        tags: { feature: 'strategies-server-api', status: 500 },
        debugIds: { 'server.worker.mjs': 'debug-id' },
      },
    })
    errors.record({
      kind: 'event',
      id: '',
      event: {
        type: 'sentry',
        error: { name: 'Error', message: 'from the worker', stack: 'Error: from the worker' },
        tags: undefined,
      },
    })
    errors.record({ kind: 'idle' })

    const expected: StrategiesServerError[] = [
      {
        id: 1,
        timestamp: 1_793_800_000_000,
        name: 'TypeError',
        message: 'fetch failed',
        stack: thrown.stack,
        tags: { feature: 'strategies-server-api', status: '500' },
        debugIds: { 'server.worker.mjs': 'debug-id' },
        strategyId: 's1',
        version: '1.0.0',
      },
      {
        id: 2,
        timestamp: 1_793_800_000_000,
        name: 'Error',
        message: 'from the worker',
        stack: 'Error: from the worker',
        tags: {},
        debugIds: undefined,
        strategyId: undefined,
        version: '1.0.0',
      },
    ]
    expect(listener.mock.calls).toEqual(expected.map((error) => [error]))
    expect(errors.getUnacked()).toEqual({ errors: expected, skippedErrorsCount: 0 })
  })

  it('cuts the message and the stack to their limits before storing them', () => {
    const { db, errors: stored } = makeDb()
    const errors = createServerErrors({
      db,
      clock: new FakeClock(),
      version: null,
      maxMessageLength: 5,
      maxStackLength: 8,
      onStoreError: vi.fn(),
    })

    errors.record({
      kind: 'event',
      id: '',
      event: {
        type: 'sentry',
        error: { name: 'Error', message: 'a long message', stack: 'Error: a long message' },
        tags: undefined,
      },
    })
    errors.record({
      kind: 'event',
      id: '',
      event: { type: 'sentry', error: 'short', tags: undefined },
    })

    expect(stored.map(({ message, stack }) => ({ message, stack }))).toEqual([
      { message: 'a lon', stack: 'Error: a' },
      { message: 'short', stack: undefined },
    ])
  })

  it(`reads at most ${STRATEGIES_WS_MAX_SENT_ERRORS} unacked errors`, () => {
    const { db } = makeDb()
    const errors = createServerErrors({
      db,
      clock: new FakeClock(),
      version: null,
      ...LIMITS,
      onStoreError: vi.fn(),
    })

    errors.ack(4)
    errors.getUnacked()

    expect(db.ackErrors).toHaveBeenCalledWith(4)
    expect(db.readUnackedErrors).toHaveBeenCalledWith(STRATEGIES_WS_MAX_SENT_ERRORS)
  })

  it('reports a failed write without telling the subscribers', () => {
    const { db } = makeDb()
    vi.mocked(db.saveError).mockImplementation(() => {
      throw new Error('disk full')
    })
    const onStoreError = vi.fn()
    const errors = createServerErrors({
      db,
      clock: new FakeClock(),
      version: null,
      ...LIMITS,
      onStoreError,
    })
    const listener = vi.fn()
    errors.subscribe(listener)

    errors.record({
      kind: 'event',
      id: '',
      event: { type: 'sentry', error: 'not an error', tags: undefined },
    })

    expect(onStoreError).toHaveBeenCalledWith(new Error('disk full'))
    expect(listener).not.toHaveBeenCalled()
  })
})
