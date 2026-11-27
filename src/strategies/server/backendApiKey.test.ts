import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchApiKeyPublicKey } from './backendApiKey'

const CONFIG = { restApiBase: 'https://api.example', customServer: null }
const PUBLIC_KEY = 'ab'.repeat(40)

const respondWith = (status: number, body: unknown = null) => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(body === null ? null : JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const requestedUrl = (fetchMock: ReturnType<typeof respondWith>) =>
  String(fetchMock.mock.lastCall?.[0] instanceof URL ? fetchMock.mock.lastCall[0].href : '')

const apiKeys = (keys: { api_key_index: number; key_type?: number; public_key: string }[]) => ({
  code: 200,
  api_keys: keys.map((key) => ({ account_index: 7, nonce: 1, ...key })),
})

describe('fetchApiKeyPublicKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves to the public key registered at the index, without an auth token', async () => {
    const fetchMock = respondWith(
      200,
      apiKeys([{ api_key_index: 3, key_type: 0, public_key: PUBLIC_KEY }]),
    )
    await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).resolves.toEqual({
      keyType: 0,
      publicKey: PUBLIC_KEY,
    })
    expect(requestedUrl(fetchMock)).toBe(
      'https://api.example/api/v1/apikeys?account_index=7&api_key_index=3',
    )
    const init = fetchMock.mock.lastCall?.[1]
    expect(init?.headers).toBeUndefined()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports the key type, reading a missing one as Schnorr', async () => {
    const ecdsaKey = `02${'ab'.repeat(32)}`
    respondWith(200, apiKeys([{ api_key_index: 3, key_type: 1, public_key: ecdsaKey }]))
    await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).resolves.toEqual({
      keyType: 1,
      publicKey: ecdsaKey,
    })
    respondWith(200, apiKeys([{ api_key_index: 3, public_key: PUBLIC_KEY }]))
    await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).resolves.toEqual({
      keyType: 0,
      publicKey: PUBLIC_KEY,
    })
  })

  it('passes the custom server along', async () => {
    const fetchMock = respondWith(200, apiKeys([]))
    await fetchApiKeyPublicKey({ ...CONFIG, customServer: 'beta' }, 7, 3)
    expect(requestedUrl(fetchMock)).toContain('server=beta')
  })

  it('resolves to null when the index has no key', async () => {
    respondWith(200, apiKeys([{ api_key_index: 4, public_key: PUBLIC_KEY }]))
    await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).resolves.toBeNull()
    respondWith(400, { code: 21109, message: 'api key not found' })
    await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).resolves.toBeNull()
  })

  it.each(['0'.repeat(80), `0x${'0'.repeat(80)}`, '0X00', '', '0x'])(
    'resolves to null for a revoked key, whose public key is %j',
    async (publicKey) => {
      respondWith(200, apiKeys([{ api_key_index: 3, key_type: 0, public_key: publicKey }]))
      await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).resolves.toBeNull()
    },
  )

  it.each([
    [400, { code: 20001 }],
    [429, null],
    [500, null],
    [503, null],
  ])('throws on HTTP %i instead of reading it as no key', async (status, body) => {
    respondWith(status, body)
    await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).rejects.toThrow(`HTTP ${status}`)
  })

  it('throws when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(fetchApiKeyPublicKey(CONFIG, 7, 3)).rejects.toThrow('fetch failed')
  })
})
