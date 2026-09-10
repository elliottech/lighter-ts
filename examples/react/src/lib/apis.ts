import {
  AccountApi,
  AnnouncementApi,
  AtomicordersApi,
  BridgeApi,
  CandlestickApi,
  Configuration,
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
} from 'zklighter-perps'

import type { Apis } from 'lighter-ts'
import { authTokenInHeaderMiddleware, handleServerErrorMiddleware } from '../utils/middlewares'

const configuration = new Configuration({
  basePath: import.meta.env.VITE_REST_API_BASE,
  middleware: [authTokenInHeaderMiddleware, handleServerErrorMiddleware],
})

export const apis: Apis = {
  rootApi: new RootApi(configuration),
  accountApi: new AccountApi(configuration),
  announcementApi: new AnnouncementApi(configuration),
  candlesticksApi: new CandlestickApi(configuration),
  transactionApi: new TransactionApi(configuration),
  orderApi: new OrderApi(configuration),
  fundingApi: new FundingApi(configuration),
  infoApi: new InfoApi(configuration),
  notificationApi: new NotificationApi(configuration),
  bridgeApi: new BridgeApi(configuration),
  referralApi: new ReferralApi(configuration),
  tokenlistApi: new TokenlistApi(configuration),
  atomicordersApi: new AtomicordersApi(configuration),
  stockFinancialsApi: new StockfinancialsApi(configuration),
  marketNewsApi: new MarketnewsApi(configuration),
}
