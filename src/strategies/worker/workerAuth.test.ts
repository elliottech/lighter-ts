import { type WorkerSigner } from './protocol'
import { useLighterStore } from '../..'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SignerRejectedError,
  assertWorkerAccount,
  authenticateWorker,
  findWorkerSignerKeyError,
  getWorkerApiKeyIndex,
  isSignerKeyRejection,
  isWorkerRegistered,
} from './workerAuth'

const createClient = vi.hoisted(() => vi.fn())
const apikeys = vi.hoisted(() => vi.fn())
const captureWorkerException = vi.hoisted(() => vi.fn())

vi.mock('./captureWorkerException', () => ({ captureWorkerException }))

vi.mock('../..', async (original) => ({
  ...(await original<typeof import('../..')>()),
  createClient,
  getECDSAPubKeyExpiredAt: () => 1_800_000_600_000,
  apis: { accountApi: { apikeys } },
}))

const signer: WorkerSigner = {
  seed: 'seed-1',
  accountIndex: 42,
  apiKeyIndex: 3,
  chainId: 300,
}

describe('authenticateWorker', () => {
  beforeEach(() => {
    createClient.mockReset().mockResolvedValue({ pk: 'ABCD' })
    apikeys.mockReset()
  })

  it('creates the wasm client from the main thread signer', async () => {
    expect(isWorkerRegistered(42)).toBe(false)
    expect(() => getWorkerApiKeyIndex()).toThrow()
    await expect(authenticateWorker(signer)).resolves.toBe(42)
    expect(createClient).toHaveBeenCalledWith({
      expiredAt: 1_800_000_600_000,
      seed: 'seed-1',
      chainId: 300,
      accountIndex: 42,
      nonce: 0,
      apiKeyIndex: 3,
    })
    expect(isWorkerRegistered(42)).toBe(true)
    expect(isWorkerRegistered(7)).toBe(false)
    expect(getWorkerApiKeyIndex()).toBe(3)
    expect(useLighterStore.getState().accountIndex).toBe(42)
    expect(() => assertWorkerAccount(42)).not.toThrow()
    expect(() => assertWorkerAccount(7)).toThrow('The strategy worker signs for account 42, not 7')
  })

  it('rejects without a signer', async () => {
    await expect(authenticateWorker(null)).rejects.toThrow(
      new SignerRejectedError('missing signer'),
    )
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects when createClient fails', async () => {
    createClient.mockRejectedValue(new Error('seed must be hexadecimal'))
    await expect(authenticateWorker(signer)).rejects.toThrow(
      new SignerRejectedError('seed must be hexadecimal'),
    )
  })

  it('verifies the key is still registered for the seed', async () => {
    apikeys.mockResolvedValue({ api_keys: [{ api_key_index: 3, public_key: '0xabcd' }] })
    await expect(authenticateWorker(signer, { verifyKey: true })).resolves.toBe(42)
    expect(apikeys).toHaveBeenCalledWith({ account_index: 42, api_key_index: 3 })
    await expect(findWorkerSignerKeyError()).resolves.toBeNull()

    apikeys.mockResolvedValue({ api_keys: [{ api_key_index: 3, public_key: '0x0000' }] })
    await expect(findWorkerSignerKeyError()).resolves.toBe(
      'API key is no longer registered, authenticate again',
    )
  })

  it('rejects a seed whose key was revoked or replaced, logging its key and account', async () => {
    captureWorkerException.mockReset()
    apikeys.mockResolvedValue({ api_keys: [] })
    await expect(authenticateWorker(signer, { verifyKey: true })).rejects.toThrow(
      new SignerRejectedError('API key is no longer registered, authenticate again'),
    )
    expect(captureWorkerException).toHaveBeenCalledWith(
      new Error('The API key is no longer registered for this seed'),
      { tags: { feature: 'strategy-worker-signer-key', accountIndex: 42, apiKeyIndex: 3 } },
    )
  })

  it('rejects a key index that was never registered', async () => {
    const response = new Response(JSON.stringify({ code: 21109, message: 'api key not found' }), {
      status: 400,
    })
    apikeys.mockRejectedValue(
      Object.assign(new Error('Response returned an error code'), {
        name: 'ResponseError',
        response,
      }),
    )
    await expect(authenticateWorker(signer, { verifyKey: true })).rejects.toThrow(
      'API key is no longer registered, authenticate again',
    )
  })

  it('fails the check, without rejecting the key, when the request fails', async () => {
    apikeys.mockRejectedValue(new TypeError('fetch failed'))
    await expect(authenticateWorker(signer, { verifyKey: true })).rejects.toThrow('fetch failed')
    await expect(authenticateWorker(signer, { verifyKey: true })).rejects.not.toBeInstanceOf(
      SignerRejectedError,
    )
    const response = new Response(JSON.stringify({ code: 20001 }), { status: 400 })
    apikeys.mockRejectedValue(
      Object.assign(new Error('bad request'), { name: 'ResponseError', response }),
    )
    await expect(authenticateWorker(signer, { verifyKey: true })).rejects.toThrow('bad request')
  })

  it('does not check the key unless asked', async () => {
    await authenticateWorker(signer)
    expect(apikeys).not.toHaveBeenCalled()
  })
})

describe('isSignerKeyRejection', () => {
  const response = (status: number, body: unknown = { code: 20001 }) =>
    new Response(JSON.stringify(body), { status })

  it('is a 401, or sendTx rejecting the public key', async () => {
    await expect(isSignerKeyRejection(response(401))).resolves.toBe(true)
    await expect(isSignerKeyRejection(response(400, { code: 21108 }))).resolves.toBe(true)
  })

  it('is not any other failure', async () => {
    await expect(isSignerKeyRejection(response(400))).resolves.toBe(false)
    await expect(isSignerKeyRejection(new Response('nope', { status: 400 }))).resolves.toBe(false)
    await expect(isSignerKeyRejection(response(429))).resolves.toBe(false)
    await expect(isSignerKeyRejection(response(500))).resolves.toBe(false)
  })
})
