import {
  API_KEY_INDEXES,
  generateTimestampClientOrderIndex,
  initCommonPackage,
  Platform,
  useLighterStore,
} from 'lighter-ts'
import fallbacks from 'lighter-ts/fallbacks/mainnet'
import { signers, apis, persistence, sha256, errorReporting, errorToast } from '../lib'
import { isRegistered } from './isRegistered'

export const initReactStore = () => {
  initCommonPackage({
    setItem: persistence.setItem,
    getItem: persistence.getItem,
    sha256: sha256,
    apiClients: apis,
    env: 'mainnet',
    fallbacks,
    websocketConfigParam: {
      flushInterval: 250,
      throttleInterval: 500,
      accountThrottleInterval: 50,
    },
    captureException: errorReporting.captureException,
    showToastFromError: errorToast.showToastFromError,
    signers,
    getApiKeyIndex: () => {
      return API_KEY_INDEXES.DESKTOP
    },
    getPlatform: () => {
      return Platform.PlatformWeb
    },
    generateClientOrderIndex: generateTimestampClientOrderIndex,
    isRegistered,
    rpcToken: null,
    skipNonce: true,
  })

  useLighterStore.getState().loadPreferences()
}
