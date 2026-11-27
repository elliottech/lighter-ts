import { MutationObserver, onlineManager } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'

import { queryClient } from './queryClient'

afterEach(() => onlineManager.setOnline(true))

it('runs a mutation while the browser reports offline instead of holding it', async () => {
  onlineManager.setOnline(false)
  const mutationFn = vi.fn(() => Promise.resolve('sent'))

  const result = await new MutationObserver(queryClient, { mutationFn }).mutate()

  expect(mutationFn).toHaveBeenCalledTimes(1)
  expect(result).toBe('sent')
})
