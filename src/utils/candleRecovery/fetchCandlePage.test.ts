import { afterEach, expect, it, vi } from 'vitest'
import { fetchCandlePage } from './fetchCandlePage'

afterEach(() => vi.useRealTimers())

it('settles the timeout even when a transport ignores its signal', async () => {
  vi.useFakeTimers()
  let settled = false
  let transportSignal: AbortSignal | undefined
  const result = fetchCandlePage(undefined, (signal) => {
    transportSignal = signal
    return new Promise(() => {})
  }).catch((error: Error) => {
    settled = true
    return error.name
  })
  await vi.advanceTimersByTimeAsync(15_000)
  expect(transportSignal?.aborted).toBe(true)
  expect(settled).toBe(true)
  expect(await result).toBe('TimeoutError')
  expect(vi.getTimerCount()).toBe(0)
})

it('settles parent cancellation and handles a later transport rejection', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  let rejectTransport: (error: Error) => void = () => {}
  let settled = false
  const result = fetchCandlePage(
    controller.signal,
    () =>
      new Promise((_, reject) => {
        rejectTransport = reject
      }),
  ).catch((error: Error) => {
    settled = true
    return error.name
  })
  controller.abort()
  await vi.advanceTimersByTimeAsync(0)
  expect(settled).toBe(true)
  expect(await result).toBe('AbortError')
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
  rejectTransport(new Error('late transport failure'))
  await vi.advanceTimersByTimeAsync(0)
})

it('cleans up after success and does not start an already cancelled request', async () => {
  vi.useFakeTimers()
  expect(await fetchCandlePage(undefined, () => Promise.resolve(42))).toBe(42)
  expect(vi.getTimerCount()).toBe(0)
  const controller = new AbortController()
  controller.abort()
  const run = vi.fn()
  await expect(fetchCandlePage(controller.signal, run)).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(run).not.toHaveBeenCalled()
})
