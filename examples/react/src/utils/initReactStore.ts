import { API_KEY_INDEXES, initCommonPackage, Platform, useLighterStore } from 'lighter-ts'
import { signers, apis, persistence, sha256, errorReporting, errorToast } from '../lib'
import { isRegistered } from './isRegistered'

export const initReactStore = () => {
  initCommonPackage({
    setItem: persistence.setItem,
    getItem: persistence.getItem,
    sha256: sha256,
    accountApi: apis.accountApi,
    announcementApi: apis.announcementApi,
    bridgeApi: apis.bridgeApi,
    candlesticksApi: apis.candlesticksApi,
    fundingApi: apis.fundingApi,
    infoApi: apis.infoApi,
    notificationApi: apis.notificationApi,
    orderApi: apis.orderApi,
    referralApi: apis.referralApi,
    rootApi: apis.rootApi,
    stockFinancialsApi: apis.stockFinancialsApi,
    tokenlistApi: apis.tokenlistApi,
    transactionApi: apis.transactionApi,
    atomicordersApi: apis.atomicordersApi,
    marketNewsApi: apis.marketNewsApi,
    env: 'mainnet',
    websocketConfigParam: {
      flushInterval: 250,
      throttleInterval: 500,
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
    isRegistered,
    skipNonce: true,
  })

  useLighterStore.getState().loadPreferences()
}
