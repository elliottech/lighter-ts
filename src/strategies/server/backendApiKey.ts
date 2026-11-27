import type { StrategyWorkerConfig } from '../worker/strategyWorkerConfig'

// Plain fetch, not `apis.accountApi`: this runs in server.main, which never calls
// initCommonPackage, and importing the shared package here would pull the store,
// its polyfills and the generated API client into the main process.

/** An API key's public key; `keyType` is 0 for Schnorr keys and 1 for ECDSA (secp256k1) keys. */
export interface ApiPublicKey {
  keyType: number
  publicKey: string
}

const FETCH_API_KEY_TIMEOUT_MS = 10_000
const API_KEY_NOT_FOUND_CODE = 21109

/**
 * Resolves to the public key and key type the account registered at the API key index, null when it has
 * none. Rejects when the backend can't tell (5xx, 429, timeout, network error) so a blip isn't
 * read as a revoked key.
 */
export const fetchApiKeyPublicKey = async (
  config: Pick<StrategyWorkerConfig, 'restApiBase' | 'customServer'>,
  accountIndex: number,
  apiKeyIndex: number,
): Promise<ApiPublicKey | null> => {
  const url = new URL('/api/v1/apikeys', config.restApiBase)
  url.searchParams.set('account_index', String(accountIndex))
  url.searchParams.set('api_key_index', String(apiKeyIndex))
  if (config.customServer) url.searchParams.set('server', config.customServer)
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_API_KEY_TIMEOUT_MS) })
  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as { code?: number } | null
    if (body?.code === API_KEY_NOT_FOUND_CODE) return null
  }
  if (!response.ok) throw new Error(`Fetching an API key failed with HTTP ${response.status}`)
  const { api_keys } = (await response.json()) as {
    api_keys?: { api_key_index?: number; key_type?: number; public_key?: string }[]
  }
  const key = api_keys?.find((apiKey) => apiKey.api_key_index === apiKeyIndex)
  if (key?.public_key === undefined || /^(0x)?0*$/i.test(key.public_key)) return null
  return { keyType: key.key_type ?? 0, publicKey: key.public_key }
}
