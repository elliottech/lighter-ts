import { afterEach, expect, it, vi } from 'vitest'

import { shouldUseECDSA } from '../lib/env'
import { transactionConfig } from '../lib/transactionConfig'
import { TxTypes } from '../types/user'
import {
  changePubKey,
  createClient,
  getChangePubKeyTransaction,
  getChangePubKeyTxType,
  getECDSAPubKeyExpiredAt,
  getRevokePubKeyTransaction,
  revokePubKey,
} from './auth'
import { handleAndSendTxResponse, sendTx } from './sendTx'

vi.mock('./sendTx', () => ({ handleAndSendTxResponse: vi.fn(), sendTx: vi.fn() }))
vi.mock('../lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/env')>()),
  shouldUseECDSA: vi.fn(),
}))

const originalSigners = transactionConfig.signers

it.each([true, false])('selects the key transaction type with ECDSA enabled: %s', (ecdsa) => {
  vi.mocked(shouldUseECDSA).mockReturnValue(ecdsa)
  expect(getChangePubKeyTxType()).toBe(ecdsa ? 54 : 8)
})

afterEach(() => {
  transactionConfig.signers = originalSigners
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([true, false])(
  'dispatches the matching key transaction type with ECDSA enabled: %s',
  async (ecdsa) => {
    vi.mocked(shouldUseECDSA).mockReturnValue(ecdsa)
    const tx = { txInfo: 'body', txHash: 'hash' }
    transactionConfig.signers = {
      signChangePubKey: vi.fn().mockResolvedValue(tx),
      signRevokePubKey: vi.fn().mockResolvedValue(tx),
    } as unknown as typeof transactionConfig.signers
    const params = {
      accountIndex: 7,
      nonce: 3,
      apiKeyIndex: 4,
      signature: 'sig',
      expiredAt: 1_800_000_600_000,
    }
    const type = ecdsa ? TxTypes.TxTypeL2ChangeECDSAPubKey : TxTypes.TxTypeL2ChangePubKey
    await changePubKey({ ...params, skipConfirmation: true })
    expect(transactionConfig.signers.signChangePubKey).toHaveBeenLastCalledWith(params)
    expect(sendTx).toHaveBeenLastCalledWith(type, tx)
    await changePubKey(params)
    expect(handleAndSendTxResponse).toHaveBeenLastCalledWith(type, tx)
    vi.mocked(handleAndSendTxResponse).mockClear()
    await revokePubKey(params)
    expect(transactionConfig.signers.signRevokePubKey).toHaveBeenCalledExactlyOnceWith(params)
    expect(handleAndSendTxResponse).toHaveBeenCalledExactlyOnceWith(type, tx)
  },
)

it('computes a transaction expiry ten minutes from now', () => {
  vi.useFakeTimers().setSystemTime(1_800_000_000_000)
  expect(getECDSAPubKeyExpiredAt()).toBe(1_800_000_600_000)
})

it('forwards expiry through client creation and change/revoke preparation', async () => {
  const create = vi.fn().mockResolvedValue({})
  const change = vi.fn().mockResolvedValue({})
  const revoke = vi.fn().mockResolvedValue({})
  transactionConfig.signers = {
    ...originalSigners,
    createClient: create,
    getChangePubKeyTransaction: change,
    getRevokePubKeyTransaction: revoke,
  }
  const params = { accountIndex: 7, apiKeyIndex: 4, nonce: 3, expiredAt: 1_800_000_600_000 }
  await createClient({ ...params, seed: 'ab', chainId: 300, skipNonce: false })
  expect(create).toHaveBeenCalledExactlyOnceWith({
    ...params,
    seed: 'ab',
    chainId: 300,
    skipNonce: false,
  })
  await getChangePubKeyTransaction(params)
  expect(change).toHaveBeenCalledExactlyOnceWith(params)
  await getRevokePubKeyTransaction(params)
  expect(revoke).toHaveBeenCalledExactlyOnceWith(params)
})
