import { type WorkerSigner } from './protocol'
import { apis, createClient, getECDSAPubKeyExpiredAt, useLighterStore } from '../..'
import { formatUnknownError } from '../engine/errors'
import { captureWorkerException } from './captureWorkerException'

/** The seed or its API key is unusable; only a new signer fixes it, unlike a failed request. */
export class SignerRejectedError extends Error {
  override readonly name = 'SignerRejectedError'
}

let authenticatedSigner:
  | (Pick<WorkerSigner, 'accountIndex' | 'apiKeyIndex'> & { publicKey: string })
  | null = null

const normalizeKey = (key: string) => key.toLowerCase().replace(/^0x/, '')

const API_KEY_NOT_FOUND_CODE = 21109
const INVALID_PUBLIC_KEY_CODE = 21108

/**
 * Whether a failed response is how a revoked or replaced API key shows: a 401
 * on a read authenticated with its token, or sendTx's invalid-PublicKey 400.
 */
export const isSignerKeyRejection = async (response: Response): Promise<boolean> => {
  if (response.status === 401) return true
  if (response.status !== 400) return false
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: number } | null
  return body?.code === INVALID_PUBLIC_KEY_CODE
}

// An index that never had a key is a 400, not an empty list.
const isApiKeyNotFound = async (error: unknown): Promise<boolean> => {
  const response = (error as { name?: string; response?: Response } | null)?.response
  if ((error as { name?: string } | null)?.name !== 'ResponseError' || response?.status !== 400)
    return false
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: number } | null
  return body?.code === API_KEY_NOT_FOUND_CODE
}

/** Null while the key is registered with this public key; throws when the check itself fails. */
const findSignerKeyError = async (
  accountIndex: number,
  apiKeyIndex: number,
  publicKey: string,
): Promise<string | null> => {
  const apiKeys = await apis.accountApi
    .apikeys({ account_index: accountIndex, api_key_index: apiKeyIndex })
    .then(
      ({ api_keys }) => api_keys,
      async (error: unknown) => {
        if (await isApiKeyNotFound(error)) return []
        throw error
      },
    )
  const registered = apiKeys.find((key) => key.api_key_index === apiKeyIndex)?.public_key
  if (registered && normalizeKey(registered) === normalizeKey(publicKey)) return null
  captureWorkerException(new Error('The API key is no longer registered for this seed'), {
    tags: { feature: 'strategy-worker-signer-key', accountIndex, apiKeyIndex },
  })
  return 'API key is no longer registered, authenticate again'
}

export const findWorkerSignerKeyError = (): Promise<string | null> => {
  if (!authenticatedSigner)
    return Promise.reject(new Error('The strategy worker is not authenticated'))
  const { accountIndex, apiKeyIndex, publicKey } = authenticatedSigner
  return findSignerKeyError(accountIndex, apiKeyIndex, publicKey)
}

export const isWorkerRegistered = (accountIndex: number) =>
  authenticatedSigner?.accountIndex === accountIndex

export const getWorkerAccountIndex = (): number | null => authenticatedSigner?.accountIndex ?? null

/** The worker holds one wasm client; it cannot sign for any other account. */
export const assertWorkerAccount = (accountIndex: number): void => {
  if (isWorkerRegistered(accountIndex)) return
  throw new Error(
    `The strategy worker signs for account ${getWorkerAccountIndex()}, not ${accountIndex}`,
  )
}

export const getWorkerApiKeyIndex = (): number => {
  if (!authenticatedSigner) {
    throw new Error('The strategy worker is not authenticated')
  }
  return authenticatedSigner.apiKeyIndex
}

/** Resolves to the account the worker's wasm client was created for. */
export const authenticateWorker = async (
  signer: WorkerSigner | null,
  { verifyKey = false }: { verifyKey?: boolean } = {},
): Promise<number> => {
  if (!signer) throw new SignerRejectedError('missing signer')
  const { pk } = await createClient({
    expiredAt: getECDSAPubKeyExpiredAt(),
    seed: signer.seed,
    chainId: signer.chainId,
    accountIndex: signer.accountIndex,
    nonce: 0,
    apiKeyIndex: signer.apiKeyIndex,
  }).catch((error: unknown) => {
    throw new SignerRejectedError(formatUnknownError(error))
  })
  if (verifyKey) {
    const keyError = await findSignerKeyError(signer.accountIndex, signer.apiKeyIndex, pk)
    if (keyError !== null) throw new SignerRejectedError(keyError)
  }
  authenticatedSigner = {
    accountIndex: signer.accountIndex,
    apiKeyIndex: signer.apiKeyIndex,
    publicKey: pk,
  }
  // Store selectors default to this account, as they do on the main thread.
  useLighterStore.setState({ accountIndex: signer.accountIndex })
  return signer.accountIndex
}
