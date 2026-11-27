import {
  AccountApi,
  AnnouncementApi,
  AtomicordersApi,
  BridgeApi,
  CandlestickApi,
  CompetitionApi,
  type Configuration,
  EarningsApi,
  EventApi,
  FundingApi,
  GeoApi,
  GuildApi,
  InfoApi,
  LivepointsApi,
  MarketnewsApi,
  NotificationApi,
  OrderApi,
  PortfolioApi,
  PushnotifApi,
  ReferralApi,
  RootApi,
  SavingsApi,
  StockfinancialsApi,
  TokenlistApi,
  TransactionApi,
  UpdownApi,
} from 'zklighter-perps'

export interface Apis {
  accountApi: AccountApi
  announcementApi: AnnouncementApi
  atomicordersApi: AtomicordersApi
  bridgeApi: BridgeApi
  candlesticksApi: CandlestickApi
  competitionApi: CompetitionApi
  earningsApi: EarningsApi
  eventApi: EventApi
  fundingApi: FundingApi
  geoApi: GeoApi
  guildApi: GuildApi
  infoApi: InfoApi
  livePointsApi: LivepointsApi
  marketNewsApi: MarketnewsApi
  notificationApi: NotificationApi
  orderApi: OrderApi
  portfolioApi: PortfolioApi
  pushnotifApi: PushnotifApi
  referralApi: ReferralApi
  rootApi: RootApi
  savingsApi: SavingsApi
  stockFinancialsApi: StockfinancialsApi
  tokenlistApi: TokenlistApi
  transactionApi: TransactionApi
  updownApi: UpdownApi
}

export const createApis = (configuration: Configuration): Apis => ({
  accountApi: new AccountApi(configuration),
  announcementApi: new AnnouncementApi(configuration),
  atomicordersApi: new AtomicordersApi(configuration),
  bridgeApi: new BridgeApi(configuration),
  candlesticksApi: new CandlestickApi(configuration),
  competitionApi: new CompetitionApi(configuration),
  earningsApi: new EarningsApi(configuration),
  eventApi: new EventApi(configuration),
  fundingApi: new FundingApi(configuration),
  geoApi: new GeoApi(configuration),
  guildApi: new GuildApi(configuration),
  infoApi: new InfoApi(configuration),
  livePointsApi: new LivepointsApi(configuration),
  marketNewsApi: new MarketnewsApi(configuration),
  notificationApi: new NotificationApi(configuration),
  orderApi: new OrderApi(configuration),
  portfolioApi: new PortfolioApi(configuration),
  pushnotifApi: new PushnotifApi(configuration),
  referralApi: new ReferralApi(configuration),
  rootApi: new RootApi(configuration),
  savingsApi: new SavingsApi(configuration),
  stockFinancialsApi: new StockfinancialsApi(configuration),
  tokenlistApi: new TokenlistApi(configuration),
  transactionApi: new TransactionApi(configuration),
  updownApi: new UpdownApi(configuration),
})

export const apis: Apis = {
  accountApi: null!,
  announcementApi: null!,
  atomicordersApi: null!,
  bridgeApi: null!,
  candlesticksApi: null!,
  competitionApi: null!,
  earningsApi: null!,
  eventApi: null!,
  fundingApi: null!,
  geoApi: null!,
  guildApi: null!,
  infoApi: null!,
  livePointsApi: null!,
  marketNewsApi: null!,
  notificationApi: null!,
  orderApi: null!,
  portfolioApi: null!,
  pushnotifApi: null!,
  referralApi: null!,
  rootApi: null!,
  savingsApi: null!,
  stockFinancialsApi: null!,
  tokenlistApi: null!,
  transactionApi: null!,
  updownApi: null!,
}
