import { afterEach, describe, expect, it, vi } from 'vitest'

import { restApiConfig } from '../lib/restApiConfig'
import { fetchUserCountry, isBOCountryBlocked } from './userCountry'

const respond = (status: number, body: unknown) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })))

describe('fetchUserCountry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    restApiConfig.base = null
  })

  it('reads the country from the REST base /location', async () => {
    restApiConfig.base = 'https://api.example'
    const fetchMock = respond(200, { country: 'kr' })
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchUserCountry()).toBe('KR')
    expect(fetchMock).toHaveBeenCalledWith('https://api.example/location')
  })

  it('is unknown without a base, on errors and without a country', async () => {
    vi.stubGlobal('fetch', respond(200, { country: 'KR' }))
    expect(await fetchUserCountry()).toBeNull()

    restApiConfig.base = 'https://api.example'
    vi.stubGlobal('fetch', respond(404, {}))
    expect(await fetchUserCountry()).toBeNull()
    vi.stubGlobal('fetch', respond(200, {}))
    expect(await fetchUserCountry()).toBeNull()
    vi.stubGlobal('fetch', respond(200, { country: '' }))
    expect(await fetchUserCountry()).toBeNull()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    )
    expect(await fetchUserCountry()).toBeNull()
  })
})

describe('isBOCountryBlocked', () => {
  it('blocks South Korea only', () => {
    expect(isBOCountryBlocked('KR')).toBe(true)
    expect(isBOCountryBlocked('TR')).toBe(false)
    expect(isBOCountryBlocked(null)).toBe(false)
    expect(isBOCountryBlocked(undefined)).toBe(false)
  })
})
