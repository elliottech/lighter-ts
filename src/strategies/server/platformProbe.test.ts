import { afterEach, describe, expect, it, vi } from 'vitest'
import { probePlatform } from './platformProbe'

const CONFIG = { restApiBase: 'https://api.example', customServer: null }

const respondWith = (body: Record<string, unknown>) => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('probePlatform', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves once ws_status reports ready', async () => {
    const fetchMock = respondWith({ code: 200, message: 'websocket is ready' })
    await expect(probePlatform(CONFIG)).resolves.toBeUndefined()
    const url = fetchMock.mock.lastCall?.[0]
    expect(url instanceof URL ? url.href : url).toBe('https://api.example/api/v1/ws_status')
  })

  it('rejects while the API server is still catching up', async () => {
    respondWith({ code: 500, message: 'websocket is not ready' })
    await expect(probePlatform(CONFIG)).rejects.toThrow('code 500')
  })
})
