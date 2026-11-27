import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { apis } from '../lib/apis'
import { keepRefreshingAccounts } from './keepRefreshingAccounts'

const mocks = vi.hoisted(() => ({
  waits: [] as number[],
  account: vi.fn<() => Promise<{ accounts: { index: number }[] }>>(),
}))

vi.mock('../hooks/useAccountsQuery', () => ({
  computeAccountsQueryData: (data: unknown) => ({ computed: data }),
}))
vi.mock('./common', () => ({
  wait: (duration: number) => {
    mocks.waits.push(duration)
    return Promise.resolve()
  },
}))

const hasNewAccount = ({ accounts }: { accounts: { index: number }[] }) =>
  accounts.some(({ index }) => index === 2)

let client: QueryClient

beforeEach(() => {
  vi.clearAllMocks()
  mocks.waits = []
  apis.accountApi = { account: mocks.account } as never
  client = new QueryClient()
  client.setQueryData(['account', 'address'], 'stale')
})

afterEach(() => {
  apis.accountApi = null!
})

test('keeps fetching until the change shows up, then stores it and stops', async () => {
  const updated = { accounts: [{ index: 1 }, { index: 2 }] }
  mocks.account
    .mockResolvedValueOnce({ accounts: [{ index: 1 }] })
    .mockRejectedValueOnce(new Error('Network'))
    .mockResolvedValueOnce(updated)
  const invalidate = vi.spyOn(client, 'invalidateQueries')

  await keepRefreshingAccounts(client, 'address', hasNewAccount)

  expect(mocks.account).toHaveBeenCalledTimes(3)
  expect(mocks.account).toHaveBeenCalledWith({ by: 'l1_address', value: 'address' })
  expect(mocks.waits).toEqual([10_000, 10_000, 10_000])
  expect(client.getQueryData(['account', 'address'])).toEqual({ computed: updated })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['accountMetadata'] })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['explorerAccount'] })
})

test('gives up after five minutes without touching the cached accounts', async () => {
  mocks.account.mockResolvedValue({ accounts: [{ index: 1 }] })
  const invalidate = vi.spyOn(client, 'invalidateQueries')

  await keepRefreshingAccounts(client, 'address', hasNewAccount)

  expect(mocks.account).toHaveBeenCalledTimes(30)
  expect(mocks.waits.reduce((total, duration) => total + duration, 0)).toBe(300_000)
  expect(client.getQueryData(['account', 'address'])).toBe('stale')
  expect(invalidate).not.toHaveBeenCalled()
})

test('stops once the accounts are removed, e.g. on logout', async () => {
  mocks.account.mockImplementationOnce(() => {
    client.removeQueries({ queryKey: ['account'], exact: false })
    return Promise.resolve({ accounts: [{ index: 1 }, { index: 2 }] })
  })

  await keepRefreshingAccounts(client, 'address', hasNewAccount)

  expect(mocks.account).toHaveBeenCalledTimes(1)
  expect(client.getQueryData(['account', 'address'])).toBeUndefined()
})

test('does not start fetching after the accounts were removed', async () => {
  client.removeQueries({ queryKey: ['account'], exact: false })

  await keepRefreshingAccounts(client, 'address', hasNewAccount)

  expect(mocks.account).not.toHaveBeenCalled()
})
