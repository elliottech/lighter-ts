import { Configuration } from 'zklighter-perps'

import { createApis } from 'lighter-ts'
import { authTokenInHeaderMiddleware, handleServerErrorMiddleware } from '../utils/middlewares'

const configuration = new Configuration({
  basePath: import.meta.env.VITE_REST_API_BASE,
  middleware: [authTokenInHeaderMiddleware, handleServerErrorMiddleware],
})

export const apis = createApis(configuration)
