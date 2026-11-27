import { afterEach, expect, it, vi } from 'vitest'

import { shouldUseECDSA } from '../lib/env'
import { createWasmSigners } from './wasmSigners'
import type { WasmExports } from './wasmTypes'

vi.mock('../lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/env')>()),
  shouldUseECDSA: vi.fn(),
}))

const names = [
  '_createClient',
  '_getChangePubKeyTransaction',
  '_getRevokePubKeyTransaction',
  '_signChangePubKey',
  '_signRevokePubKey',
  '_createECDSAClient',
  '_getChangeECDSAPubKeyTransaction',
  '_getRevokeECDSAPubKeyTransaction',
  '_signChangeECDSAPubKey',
  '_signRevokeECDSAPubKey',
] as const

const setup = (response: object = {}) => {
  const wasm = Object.fromEntries(
    names.map((name) => [name, vi.fn(() => Promise.resolve(() => Promise.resolve(response)))]),
  ) as unknown as WasmExports
  const signers = createWasmSigners({
    getWasm: () => wasm,
    processWasmCall: async (call) => (await call)(),
    processWasmError: (result) => {
      if ('error' in result) throw new Error(result.error)
      return result
    },
    waitForWasm: () => Promise.resolve(),
  })
  return { wasm, signers }
}

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

it.each([true, false])('routes key operations with ECDSA enabled: %s', async (ecdsa) => {
  vi.mocked(shouldUseECDSA).mockReturnValue(ecdsa)
  vi.useFakeTimers().setSystemTime(1_800_000_000_000)
  const { wasm, signers } = setup()
  const expiry = ecdsa ? [Date.now() + 10 * 60 * 1000] : []
  const params = { accountIndex: 7, nonce: 3, apiKeyIndex: 4, expiredAt: Date.now() + 600_000 }
  await signers.createClient({ ...params, seed: 'ab', chainId: 300 })
  expect(wasm[ecdsa ? '_createECDSAClient' : '_createClient']).toHaveBeenCalledWith(
    'ab',
    300,
    7,
    3,
    ...expiry,
    4,
    false,
  )
  for (const operation of ['Change', 'Revoke'] as const) {
    await signers[`get${operation}PubKeyTransaction`](params)
    expect(wasm[`_get${operation}${ecdsa ? 'ECDSA' : ''}PubKeyTransaction`]).toHaveBeenCalledWith(
      7,
      3,
      ...expiry,
      4,
    )
    vi.advanceTimersByTime(5000)
    await signers[`sign${operation}PubKey`]({ ...params, signature: 'sig' })
    expect(wasm[`_sign${operation}${ecdsa ? 'ECDSA' : ''}PubKey`]).toHaveBeenCalledWith(
      7,
      'sig',
      3,
      ...expiry,
      4,
    )
    vi.setSystemTime(1_800_000_000_000)
  }
  for (const name of names.filter((name) => name.includes('ECDSA') !== ecdsa)) {
    expect(wasm[name]).not.toHaveBeenCalled()
  }
})

it('propagates ECDSA signer errors', async () => {
  vi.mocked(shouldUseECDSA).mockReturnValue(true)
  const { signers } = setup({ error: 'signing failed' })
  await expect(
    signers.getChangePubKeyTransaction({
      accountIndex: 7,
      nonce: 3,
      apiKeyIndex: 4,
      expiredAt: 1_800_000_600_000,
    }),
  ).rejects.toThrow('signing failed')
  await expect(
    signers.signChangePubKey({
      accountIndex: 7,
      nonce: 3,
      apiKeyIndex: 4,
      signature: '',
      expiredAt: 1_800_000_600_000,
    }),
  ).rejects.toThrow('signing failed')
})

it('uses each caller expiry without retaining preparation state', async () => {
  vi.mocked(shouldUseECDSA).mockReturnValue(true)
  const { wasm, signers } = setup()
  const params = { accountIndex: 7, apiKeyIndex: 4, nonce: 3, signature: 'sig' }
  await signers.getChangePubKeyTransaction({ ...params, expiredAt: 1_800_000_600_000 })
  await signers.getChangePubKeyTransaction({ ...params, expiredAt: 1_800_000_700_000 })
  await signers.signChangePubKey({ ...params, expiredAt: 1_800_000_600_000 })
  await signers.signChangePubKey({ ...params, expiredAt: 1_800_000_700_000 })
  expect(wasm._signChangeECDSAPubKey).toHaveBeenNthCalledWith(1, 7, 'sig', 3, 1_800_000_600_000, 4)
  expect(wasm._signChangeECDSAPubKey).toHaveBeenNthCalledWith(2, 7, 'sig', 3, 1_800_000_700_000, 4)
})

it.each([
  'createClient',
  'getChangePubKeyTransaction',
  'getRevokePubKeyTransaction',
  'signChangePubKey',
  'signRevokePubKey',
] as const)('does not call ECDSA WASM when %s is missing expiredAt', async (method) => {
  vi.mocked(shouldUseECDSA).mockReturnValue(true)
  const { wasm, signers } = setup()
  await expect(
    signers[method]({
      accountIndex: 7,
      apiKeyIndex: 4,
      nonce: 3,
      signature: '',
      seed: 'ab',
      chainId: 300,
    }),
  ).rejects.toThrow('requires expiredAt')
  for (const name of names) expect(wasm[name]).not.toHaveBeenCalled()
})
