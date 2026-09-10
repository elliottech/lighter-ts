import type { RequestContext, ResponseContext } from 'zklighter-perps'
import { getOrCreateAuthToken, resetAuthToken } from './auth'
import { queryClient, useLighterStore } from 'lighter-ts'
import { removeLSSignature } from './auth-storage'

const SKIPPED_AUTH_URLS = ['nextNonce']

const CANDLESTICK_URLS = ['api/v1/candles', 'api/v1/markPriceCandles']

export const authTokenInHeaderMiddleware = {
  pre: async (requestContext: RequestContext) => {
    const url = new URL(requestContext.url)
    const headers = new Headers(requestContext.init.headers)

    // Only skip auth token for certain URLs
    if (SKIPPED_AUTH_URLS.some((url) => requestContext.url.includes(url))) {
      return {
        ...requestContext,
        url: url.toString(),
        init: {
          ...requestContext.init,
          headers,
        },
      }
    }

    if (CANDLESTICK_URLS.some((url) => requestContext.url.includes(url))) {
      url.searchParams.set('optimize', 'true')
    }

    const auth = await getOrCreateAuthToken(useLighterStore.getState().accountIndex)
    if (auth) {
      headers.set('PreferAuthServer', 'true')
      headers.set('Authorization', auth.token)
    }
    return {
      ...requestContext,
      url: url.toString(),
      init: {
        ...requestContext.init,
        headers,
      },
    }
  },
}

const getDescriptionFromResponse = (response: Response) => {
  if (response.status === 429) {
    return 'health_warning_429'
  }
  if (response.status === 405) {
    return 'health_warning_405'
  }
  return 'health_warning_generic'
}

const handleInvalidSignature = async (response: Response) => {
  if (response.status !== 400) return false

  try {
    const body = (await response.json()) as {
      code: number
      message: string
    }

    if (body.code === 29500 && body.message.includes('invalid signature')) {
      // we need to remove the cached data. Invalidating query is not enough
      // isRegistered queryFn is checking it's own cached data, so we need to
      // remove it to completely trigger a re-fetch
      removeLSSignature()
      resetAuthToken()
      queryClient.removeQueries({
        queryKey: ['isRegistered'],
      })
      return true
    }
  } catch {
    console.log('Invalid signature response is not valid JSON')
  }

  return false
}

export const handleServerErrorMiddleware = {
  post: async (responseContext: ResponseContext) => {
    const { response, init } = responseContext
    const status = response.status
    const method = init.method

    if (await handleInvalidSignature(response)) return

    if (method !== 'GET') return
    if (status !== 405 && status !== 429) return

    console.error(getDescriptionFromResponse(response))
  },
}
