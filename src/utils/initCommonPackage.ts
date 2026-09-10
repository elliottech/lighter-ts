import '@formatjs/intl-getcanonicallocales/polyfill.js'
import '@formatjs/intl-locale/polyfill.js'
import '@formatjs/intl-pluralrules/polyfill.js'
import '@formatjs/intl-pluralrules/locale-data/en'
import '@formatjs/intl-numberformat/polyfill.js'
import '@formatjs/intl-numberformat/locale-data/en'

import {
  AccountApi,
  AnnouncementApi,
  BridgeApi,
  CandlestickApi,
  FundingApi,
  InfoApi,
  MarketnewsApi,
  NotificationApi,
  OrderApi,
  ReferralApi,
  RootApi,
  StockfinancialsApi,
  TokenlistApi,
  TransactionApi,
  AtomicordersApi,
} from 'zklighter-perps'
import { persistence, type Persistence } from '../lib/persistence'
import { currentEnv, isRobinhoodEnv, type Env } from '../lib/env'
import { sha256, type Sha256 } from '../lib/sha256'
import { websocketConfig, type WebsocketConfig } from '../ws-sub-store/websocketConfig'
import { errorReporting, type CaptureException } from '../lib/errorReporting'
import { errorToast, type ShowToastFromError } from '../lib/errorToast'
import type { Signers } from '../types/signers'
import type { Platform } from '../types/Platform'
import { apis } from '../lib/apis'
import { transactionConfig } from '../lib/transactionConfig'
import { useLighterStore } from '../store/useLighterStore'

type InitCommonPackageParams = {
  setItem: Persistence['setItem']
  getItem: Persistence['getItem']
  env: Env
  sha256: Sha256
  accountApi: AccountApi
  announcementApi: AnnouncementApi
  bridgeApi: BridgeApi
  candlesticksApi: CandlestickApi
  fundingApi: FundingApi
  infoApi: InfoApi
  notificationApi: NotificationApi
  orderApi: OrderApi
  referralApi: ReferralApi
  rootApi: RootApi
  stockFinancialsApi: StockfinancialsApi
  tokenlistApi: TokenlistApi
  transactionApi: TransactionApi
  atomicordersApi: AtomicordersApi
  marketNewsApi: MarketnewsApi
  websocketConfigParam: WebsocketConfig
  captureException: CaptureException
  showToastFromError: ShowToastFromError
  signers: Signers
  getApiKeyIndex: () => number
  getPlatform: () => Platform
  isRegistered: (accountIndex: number) => boolean
  skipNonce?: boolean
}

export const initCommonPackage = ({
  setItem,
  getItem,
  env,
  sha256: sha256Impl,
  accountApi,
  announcementApi,
  bridgeApi,
  candlesticksApi,
  fundingApi,
  infoApi,
  notificationApi,
  orderApi,
  referralApi,
  rootApi,
  stockFinancialsApi,
  tokenlistApi,
  transactionApi,
  atomicordersApi,
  marketNewsApi,
  websocketConfigParam,
  captureException: captureExceptionImpl,
  showToastFromError,
  signers,
  getApiKeyIndex,
  getPlatform,
  isRegistered,
  skipNonce = false,
}: InitCommonPackageParams) => {
  persistence.setItem = setItem
  persistence.getItem = getItem
  currentEnv.env = env
  sha256.digest = sha256Impl.digest
  apis.accountApi = accountApi
  apis.announcementApi = announcementApi
  apis.bridgeApi = bridgeApi
  apis.candlesticksApi = candlesticksApi
  apis.fundingApi = fundingApi
  apis.infoApi = infoApi
  apis.notificationApi = notificationApi
  apis.orderApi = orderApi
  apis.referralApi = referralApi
  apis.rootApi = rootApi
  apis.stockFinancialsApi = stockFinancialsApi
  apis.tokenlistApi = tokenlistApi
  apis.transactionApi = transactionApi
  apis.atomicordersApi = atomicordersApi
  apis.marketNewsApi = marketNewsApi
  websocketConfig.flushInterval = websocketConfigParam.flushInterval
  websocketConfig.throttleInterval = websocketConfigParam.throttleInterval
  errorReporting.captureException = captureExceptionImpl
  errorToast.showToastFromError = showToastFromError
  transactionConfig.signers = signers
  transactionConfig.isRegistered = isRegistered
  transactionConfig.getApiKeyIndex = getApiKeyIndex
  transactionConfig.getPlatform = getPlatform
  transactionConfig.skipNonce = skipNonce

  // The store is created at import time with bundled fallback data (Lighter
  // markets/assets/tokens). Robinhood runs against a different exchange, so seed
  // empty collections instead and let the API/WS populate the real data.
  if (isRobinhoodEnv()) {
    useLighterStore.setState({
      perpsOrderBookMetas: {},
      spotOrderBookMetas: {},
      assetMetas: {},
      tokens: [],
    })
  }
}
