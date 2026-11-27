import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configureWorkerIdle,
  markWorkerBusy,
  scheduleWorkerIdleCheck,
  trackWorkerTask,
} from './workerIdle'

const flushStrategyStoreWrites = vi.hoisted(() => vi.fn())

vi.mock('../store/strategyStorage', () => ({ flushStrategyStoreWrites }))

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 1))

describe('worker idle', () => {
  let busy: boolean
  let onIdle: Mock<() => void>

  beforeEach(() => {
    busy = false
    onIdle = vi.fn()
    flushStrategyStoreWrites.mockReset().mockResolvedValue(undefined)
    configureWorkerIdle({ isBusy: () => busy, onIdle })
  })

  afterEach(() => {
    configureWorkerIdle({ isBusy: () => true, onIdle: () => {} })
  })

  it('reports idle once engines and starts are gone', async () => {
    busy = true
    scheduleWorkerIdleCheck()
    await settle()
    expect(onIdle).not.toHaveBeenCalled()

    busy = false
    scheduleWorkerIdleCheck()
    await settle()
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('waits for in-flight tasks, including failed ones', async () => {
    const rpc = deferred()
    const lookup = deferred()
    void trackWorkerTask(rpc.promise).catch(() => {})
    void trackWorkerTask(lookup.promise)
    scheduleWorkerIdleCheck()
    await settle()
    expect(onIdle).not.toHaveBeenCalled()

    rpc.reject(new Error('rpc failed'))
    await settle()
    expect(onIdle).not.toHaveBeenCalled()

    lookup.resolve()
    await settle()
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('returns the task untouched', async () => {
    await expect(trackWorkerTask(Promise.resolve(7))).resolves.toBe(7)
    const failure = new Error('nope')
    await expect(trackWorkerTask(Promise.reject(failure))).rejects.toBe(failure)
  })

  it('counts work started by the continuation of a settled task', async () => {
    const rpc = deferred()
    const followUp = deferred()
    void trackWorkerTask(rpc.promise).then(() => {
      void trackWorkerTask(followUp.promise)
    })
    rpc.resolve()
    await settle()
    expect(onIdle).not.toHaveBeenCalled()

    followUp.resolve()
    await settle()
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('flushes pending store writes before reporting', async () => {
    const write = deferred()
    flushStrategyStoreWrites.mockReturnValue(write.promise)
    scheduleWorkerIdleCheck()
    await settle()
    expect(flushStrategyStoreWrites).toHaveBeenCalled()
    expect(onIdle).not.toHaveBeenCalled()

    write.resolve()
    await settle()
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('does not report idle for work that arrived while flushing', async () => {
    const write = deferred()
    flushStrategyStoreWrites.mockReturnValue(write.promise)
    scheduleWorkerIdleCheck()
    await settle()
    busy = true
    write.resolve()
    await settle()
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('reports idle once per busy period', async () => {
    scheduleWorkerIdleCheck()
    await settle()
    scheduleWorkerIdleCheck()
    await settle()
    expect(onIdle).toHaveBeenCalledTimes(1)

    markWorkerBusy()
    scheduleWorkerIdleCheck()
    await settle()
    expect(onIdle).toHaveBeenCalledTimes(2)
  })
})
