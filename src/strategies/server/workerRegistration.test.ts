import { describe, expect, it, vi } from 'vitest'
import {
  type RegistrationTxRequest,
  signRegistrationTx,
  signWorkerRegistration,
} from './workerRegistration'

vi.mock('../..', async (original) => ({
  ...(await original<typeof import('../..')>()),
  getECDSAPubKeyExpiredAt: () => 1_800_000_600_000,
}))

const REQUEST: RegistrationTxRequest = {
  seed: 'ab'.repeat(32),
  chainId: 300,
  accountIndex: 7,
  apiKeyIndex: 4,
  nonce: 3,
}

const signers = (txInfo: Record<string, unknown> = { L1Sig: '0x00', ExpiredAt: 1000 }) => ({
  createClient: vi.fn((_: { seed: string }) =>
    Promise.resolve({ pk: 'cd'.repeat(40), prv: 'unused', body: 'unused' }),
  ),
  signChangePubKey: vi.fn(() =>
    Promise.resolve({ txInfo: JSON.stringify(txInfo), txHash: 'unused' }),
  ),
})

describe('signRegistrationTx', () => {
  it('signs with a placeholder L1Sig and hands the tx out with an empty one', async () => {
    const fake = signers({ AccountIndex: 7, L1Sig: `0x${'00'.repeat(65)}`, ExpiredAt: 1000 })

    expect(await signRegistrationTx(fake, REQUEST)).toEqual({
      publicKey: 'cd'.repeat(40),
      txInfo: JSON.stringify({ AccountIndex: 7, L1Sig: '', ExpiredAt: 1000 }),
      expiredAt: 1000,
    })
    expect(fake.createClient).toHaveBeenCalledWith({
      ...REQUEST,
      skipNonce: true,
      expiredAt: 1_800_000_600_000,
    })
    expect(fake.signChangePubKey).toHaveBeenCalledWith({
      accountIndex: 7,
      signature: `0x${'00'.repeat(65)}`,
      expiredAt: 1_800_000_600_000,
      nonce: 3,
      apiKeyIndex: 4,
    })
  })

  it('throws on a tx without ExpiredAt', async () => {
    await expect(signRegistrationTx(signers({ L1Sig: '' }), REQUEST)).rejects.toThrow(
      'The signed changePubKey has no ExpiredAt',
    )
  })
})

describe('signWorkerRegistration', () => {
  const target = { accountIndex: 7, apiKeyIndex: 4, chainId: 300 }

  it('signs a new seed with the next nonce when the target has none', async () => {
    const fake = signers()
    const fetchNonce = vi.fn(() => Promise.resolve(9))

    const signed = await signWorkerRegistration(
      { ...target, seed: null },
      { signers: fake, fetchNonce, generateSeed: () => 'ef'.repeat(32) },
    )

    expect(fetchNonce).toHaveBeenCalledWith(7, 4)
    expect(fake.createClient.mock.calls[0]?.[0]).toMatchObject({ seed: 'ef'.repeat(32), nonce: 9 })
    expect(signed).toMatchObject({
      seed: 'ef'.repeat(32),
      accountIndex: 7,
      apiKeyIndex: 4,
      nonce: 9,
    })
  })

  it('signs the pending seed again when the target has one', async () => {
    const fake = signers()
    const generateSeed = vi.fn(() => 'ef'.repeat(32))

    const signed = await signWorkerRegistration(
      { ...target, seed: 'ab'.repeat(32) },
      { signers: fake, fetchNonce: () => Promise.resolve(9), generateSeed },
    )

    expect(generateSeed).not.toHaveBeenCalled()
    expect(signed.seed).toBe('ab'.repeat(32))
  })
})
