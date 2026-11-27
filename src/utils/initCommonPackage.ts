import '@formatjs/intl-getcanonicallocales/polyfill.js'
import '@formatjs/intl-locale/polyfill.js'
import '@formatjs/intl-pluralrules/polyfill.js'
import '@formatjs/intl-pluralrules/locale-data/en.js'
import '@formatjs/intl-numberformat/polyfill.js'
import '@formatjs/intl-numberformat/locale-data/en.js'

import { persistence, type Persistence } from '../lib/persistence'
import { currentEnv, type Env } from '../lib/env'
import { sha256, type Sha256 } from '../lib/sha256'
import { websocketConfig, type WebsocketConfig } from '../ws-sub-store/websocketConfig'
import { errorReporting, type CaptureException } from '../lib/errorReporting'
import { errorToast, type ShowToastFromError } from '../lib/errorToast'
import type { Signers } from '../types/signers'
import type { Platform } from '../types/Platform'
import { type Apis, apis } from '../lib/apis'
import { type GenerateClientOrderIndex, transactionConfig } from '../lib/transactionConfig'
import { restApiConfig } from '../lib/restApiConfig'
import { rpcConfig } from '../lib/rpcConfig'
import { useLighterStore } from '../store/useLighterStore'
import { type Fallbacks, type TokensOnlyFallbacks, fallbackData } from '../fallbacks'
import { applyFallbackTokens, applyFallbacks } from './applyFallbacks'
import { waitForApiMetas } from './waitForApiMetas'

type InitCommonPackageParams = {
  setItem: Persistence['setItem']
  getItem: Persistence['getItem']
  env: Env
  sha256: Sha256
  apiClients: Apis
  websocketConfigParam: Omit<WebsocketConfig, 'boEnabled'> &
    Partial<Pick<WebsocketConfig, 'boEnabled'>>
  captureException: CaptureException
  showToastFromError: ShowToastFromError
  signers: Signers
  getApiKeyIndex: () => number
  getPlatform: () => Platform
  generateClientOrderIndex: GenerateClientOrderIndex
  isRegistered: (accountIndex: number) => boolean
  rpcToken: string | null
  restApiBase?: string
  skipNonce?: boolean
  fallbacks: Fallbacks | TokensOnlyFallbacks | null
}

export const initCommonPackage = ({
  setItem,
  getItem,
  env,
  sha256: sha256Impl,
  apiClients,
  websocketConfigParam,
  captureException: captureExceptionImpl,
  showToastFromError,
  signers,
  getApiKeyIndex,
  getPlatform,
  generateClientOrderIndex,
  isRegistered,
  rpcToken,
  restApiBase,
  skipNonce = false,
  fallbacks,
}: InitCommonPackageParams) => {
  persistence.setItem = setItem
  persistence.getItem = getItem
  currentEnv.env = env
  sha256.digest = sha256Impl.digest
  rpcConfig.token = rpcToken
  restApiConfig.base = restApiBase ?? null
  Object.assign(apis, apiClients)
  websocketConfig.flushInterval = websocketConfigParam.flushInterval
  websocketConfig.throttleInterval = websocketConfigParam.throttleInterval
  websocketConfig.accountThrottleInterval = websocketConfigParam.accountThrottleInterval
  websocketConfig.boEnabled = websocketConfigParam.boEnabled ?? false
  errorReporting.captureException = captureExceptionImpl
  errorToast.showToastFromError = showToastFromError
  transactionConfig.signers = signers
  transactionConfig.isRegistered = isRegistered
  transactionConfig.getApiKeyIndex = getApiKeyIndex
  transactionConfig.getPlatform = getPlatform
  transactionConfig.generateClientOrderIndex = generateClientOrderIndex
  transactionConfig.skipNonce = skipNonce

  const envFallbacks = fallbacks?.env === env ? fallbacks : null
  fallbackData.tokens = envFallbacks?.tokens ?? null

  if (envFallbacks && 'orderBookMetas' in envFallbacks) {
    fallbackData.current = envFallbacks
    fallbackData.ready = Promise.resolve()
    useLighterStore.setState((state) => applyFallbacks(state, envFallbacks))
  } else {
    const { tokens } = fallbackData
    if (tokens) {
      useLighterStore.setState((state) => ({ tokens: applyFallbackTokens(state, tokens) }))
    }
    fallbackData.ready = waitForApiMetas()
  }
}
