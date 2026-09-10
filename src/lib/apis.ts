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
  AtomicordersApi,
  TransactionApi,
} from 'zklighter-perps'

export interface Apis {
  accountApi: AccountApi
  announcementApi: AnnouncementApi
  bridgeApi: BridgeApi
  candlesticksApi: CandlestickApi
  fundingApi: FundingApi
  infoApi: InfoApi
  marketNewsApi: MarketnewsApi
  notificationApi: NotificationApi
  orderApi: OrderApi
  referralApi: ReferralApi
  rootApi: RootApi
  stockFinancialsApi: StockfinancialsApi
  tokenlistApi: TokenlistApi
  atomicordersApi: AtomicordersApi
  transactionApi: TransactionApi
}

export const apis: Apis = {
  accountApi: null!,
  announcementApi: null!,
  bridgeApi: null!,
  candlesticksApi: null!,
  fundingApi: null!,
  infoApi: null!,
  marketNewsApi: null!,
  notificationApi: null!,
  orderApi: null!,
  referralApi: null!,
  rootApi: null!,
  stockFinancialsApi: null!,
  tokenlistApi: null!,
  atomicordersApi: null!,
  transactionApi: null!,
}
