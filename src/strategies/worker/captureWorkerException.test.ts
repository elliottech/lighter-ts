import type { WorkerToMain } from './protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../..'

import { captureWorkerException, configureWorkerExceptions } from './captureWorkerException'

const sentryGlobal = globalThis as { _sentryDebugIds?: Record<string, string> }

afterEach(() => {
  delete sentryGlobal._sentryDebugIds
})

it('reports through the configured poster with string tags', () => {
  const post = vi.fn<(message: WorkerToMain) => void>()
  configureWorkerExceptions(post)

  captureWorkerException(new Error('boom'), {
    id: 'chase-1',
    tags: { feature: 'strategy-worker-api', status: 500 },
  })

  expect(post).toHaveBeenCalledOnce()
  const message = post.mock.calls[0]?.[0]
  expect(message?.kind === 'event' && message.id).toBe('chase-1')
  const event = message?.kind === 'event' ? message.event : undefined
  expect(event?.type === 'sentry' && event.error).toEqual(new Error('boom'))
  expect(event?.type === 'sentry' && event.tags).toEqual({
    feature: 'strategy-worker-api',
    status: '500',
  })
})

it("forwards the worker bundle's Sentry debug IDs", () => {
  const post = vi.fn<(message: WorkerToMain) => void>()
  configureWorkerExceptions(post)
  sentryGlobal._sentryDebugIds = {
    'Error\n    at https://app/strategy.worker-abc.js:1:1': 'worker-id',
  }

  captureWorkerException(new Error('boom'))

  const message = post.mock.calls[0]?.[0]
  const event = message?.kind === 'event' ? message.event : undefined
  expect(event?.type === 'sentry' && event.debugIds).toEqual(sentryGlobal._sentryDebugIds)
})

describe('rate limit errors', () => {
  const INTERVAL_MS = 30 * 60_000
  let now = Date.now()

  beforeEach(() => {
    vi.useFakeTimers()
    now += 2 * INTERVAL_MS
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const capture = (makeError: () => unknown, times: number) => {
    const post = vi.fn<(message: WorkerToMain) => void>()
    configureWorkerExceptions(post)
    for (let i = 0; i < times; i++) captureWorkerException(makeError())
    return post
  }

  it('reports a rejected tx rate limit once per 30 minutes', () => {
    const post = capture(
      () => new ApiError('Too Many Requests!: Not enough volume quota', 23000),
      3,
    )
    expect(post).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(INTERVAL_MS - 1)
    captureWorkerException(new ApiError('Too Many Requests!', 23000))
    expect(post).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(1)
    captureWorkerException(new ApiError('Too Many Requests!', 23000))
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('reports a 429 response once per 30 minutes', () => {
    const post = capture(() => new Error('Request failed with status 429'), 3)
    expect(post).toHaveBeenCalledOnce()
  })

  it('shares the window between a rejected tx and a 429 response', () => {
    const post = vi.fn<(message: WorkerToMain) => void>()
    configureWorkerExceptions(post)
    captureWorkerException(new ApiError('Too Many Requests!', 23000))
    captureWorkerException(new Error('Request failed with status 429'))
    expect(post).toHaveBeenCalledOnce()
  })

  it('keeps reporting other errors while rate limit errors are skipped', () => {
    const post = vi.fn<(message: WorkerToMain) => void>()
    configureWorkerExceptions(post)
    captureWorkerException(new ApiError('Too Many Requests!', 23000))
    captureWorkerException(new ApiError('Too Many Requests!', 23000))
    captureWorkerException(new ApiError('not enough margin', 21739))
    captureWorkerException(new Error('Request failed with status 500'))
    expect(post).toHaveBeenCalledTimes(3)
  })
})
