import { restApiConfig } from '../lib/restApiConfig'
import { joinBaseUrl } from './joinBaseUrl'

export const BO_BLOCKED_COUNTRIES: readonly string[] = ['KR']

// `<REST base>/location` is served by the edge, not the API, so it is not part of the SDK.
export const fetchUserCountry = async (): Promise<string | null> => {
  if (!restApiConfig.base) return null
  try {
    const response = await fetch(joinBaseUrl(restApiConfig.base, '/location'))
    if (!response.ok) return null
    const body: unknown = await response.json()
    const country =
      typeof body === 'object' && body !== null && 'country' in body ? body.country : null
    return typeof country === 'string' && country !== '' ? country.toUpperCase() : null
  } catch {
    return null
  }
}

export const isBOCountryBlocked = (country: string | null | undefined): boolean =>
  country != null && BO_BLOCKED_COUNTRIES.includes(country)
