import { z } from 'zod'
import { type StateCreator } from 'zustand'

import { UserPreferrableDateFormat } from '../../constants/datetime'
import {
  DEFAULT_MARKET_ORDER_SLIPPAGE,
  DEFAULT_SLTP_ORDER_SLIPPAGE,
  MAX_MARKET_ORDER_SLIPPAGE,
  MAX_SLTP_ORDER_SLIPPAGE,
  OrderDirections,
} from '../../constants/shared'
import { isTestingEnvironment } from '../../testing/isTestingEnvironment'
import { OrderType, type OrderPlacementInput } from '../../types/order'
import {
  type MarketType,
  type MarketCategory,
  type TokenCategory,
  TOKEN_CATEGORY_ORDER,
} from '../../types/tokenlist'
import { TIMELINES, type Timeline } from '../../utils/filters'
import { persistence } from '../../lib/persistence'
import type { RfqOrderBookSnapshot } from '../types'

const orderBookMultiplierSchema = z
  .union([z.literal(1), z.literal(10), z.literal(100), z.literal(1000), z.literal(10000)])
  .catch(1)

const defaultSizeUsdSortingState = [{ id: 'sizeUsd', desc: true }]
const defaultOISortingState = [{ id: 'openInterest', desc: true }]
const defaultMarketsPageSortingState = [
  { id: 'favorite', desc: false },
  { id: 'openInterest', desc: true },
]
const defaultMarketsSortingState = [
  { id: 'favorite', desc: false },
  { id: 'openInterest', desc: true },
]

const defaultSpotMarketsSortingState = [
  { id: 'favorite', desc: false },
  { id: 'dailyQuoteVolume', desc: true },
]

const defaultOrderTimestampSortingState = [{ id: 'order.updated_at', desc: true }]
const defaultPublicPoolsSortingState = [{ id: 'tvl', desc: true }]
const defaultMarketsRiskSortingState = [{ id: 'openInterestCap', desc: true }]

export const defaultPreferences = {
  showRawPrices: false,
  showMarkPriceCandles: false,
  showBuySellMarks: true,
  showOrderLines: true,
  showPositionLine: true,
  showLiquidationLine: true,
  showMarkPriceChartLine: false,
  isAmountInBase: true,
  postOnly: false,
  orderDirection: OrderDirections.Long,
  dismissedClaimAmounts: {},
  orderBookGroupBy: {},
  marketTradesFilterBy: {},
  favoriteMarkets: [],
  dateFormatting: UserPreferrableDateFormat.MONTH_DAY_YEAR,
  gainOption: '%' as const,
  lossOption: '%' as const,
  mobileLoginL1Address: '',
  authenticatedViaL1Changepubkey: false,
  tableSortingAssetsPortfolio: defaultSizeUsdSortingState,
  tableSortingAssetsPools: defaultSizeUsdSortingState,
  tableSortingPositionsPortfolio: defaultSizeUsdSortingState,
  tableSortingPositionsPools: defaultSizeUsdSortingState,
  tableSortingActiveOrdersPortfolio: defaultOrderTimestampSortingState,
  tableSortingTwapOrdersPortfolio: defaultOrderTimestampSortingState,
  tableSortingActiveOrdersPools: defaultOrderTimestampSortingState,
  tableSortingExplorerMarkets: defaultOISortingState,
  tableSortingMarketsPage: defaultMarketsPageSortingState,
  tableSortingMarkets: defaultMarketsSortingState,
  tableSortingSpotMarkets: defaultSpotMarketsSortingState,
  tableSortingPublicPools: defaultPublicPoolsSortingState,
  tableSortingMarketRisk: defaultMarketsRiskSortingState,
  maxSlippage: DEFAULT_MARKET_ORDER_SLIPPAGE,
  maxSLTPSlippage: DEFAULT_SLTP_ORDER_SLIPPAGE,
  conditionalLimitPrefill: true,
  orderType: OrderType.Market,
  closePositionOrderType: OrderType.Market,
  depositCapNotificationDismissed: false,
  customizableEditMode: false,
  orderbookFlashAnimation: false,
  backgroundFillNotification: false,
  orderFilledSound: false,
  orderFillSoundVariant: 'neutral' as const,
  funMode: false,
  shouldRememberMe: true,
  closedRefundsNotifs: [],
  notificationPlacement: 'bottom-right' as const,
  portfolioDateSelection: {
    statsTimeline: '1m' as Timeline,
    chartsTimeline: '1m' as Timeline,
  },
  publicPoolChartDateSelection: '1w' as Timeline,
  stakingPoolChartDateSelection: '1w' as Timeline,
  inviteToastDismissed: false,
  slWorseThanLiqToastDismissedAt: 0,
  showWithdrawalSurvey: true,
  seenFeatureHighlight: '',
  lastAnnouncementDismissed: 1771086060,
  dismissedMarketAnnouncements: {},
  hidePnl: false,
  hidePositionSize: false,
  hideSmallBalances: false,
  obSetSize: false,
  pinnedInput: 'base' as OrderPlacementInput,
  selectedMarketType: 'ALL' as MarketType,
  selectedMarketCategory: 'ALL' as MarketCategory,
  selectedTokenCategory: 'ALL' as TokenCategory,
  showDirectionBadge: false,
  skipConfirmOrder: isTestingEnvironment(),
  candlestickResolution: '5',
  currentAtomic: {
    items: [],
  },
  atomicInput: {
    orderSize: '0',
    sizeType: 'size' as 'size' | 'percentage',
  },
  atomicMaxSlippage: 1,
  atomicReduceOnly: false,
  atomicIsTwap: false,
  atomicAutoBalance: true,
  resolveEnsNames: true,
  currentRfqIds: {} as Record<string, Record<string, number>>,
  rfqOrderBookSnapshots: {} as Record<string, Record<string, RfqOrderBookSnapshot>>,
}

const sortingStateSchema = z.array(z.object({ id: z.string(), desc: z.boolean() }))
const customDateRangeSchema = z
  .object({
    startTimestamp: z.number(),
    endTimestamp: z.number(),
  })
  .refine(({ startTimestamp, endTimestamp }) => startTimestamp <= endTimestamp)

const userPreferencesSchema = z
  .object({
    preferences: z
      .object({
        showRawPrices: z.boolean().catch(defaultPreferences.showRawPrices),
        showMarkPriceCandles: z.boolean().catch(defaultPreferences.showMarkPriceCandles),
        showBuySellMarks: z.boolean().catch(defaultPreferences.showBuySellMarks),
        showOrderLines: z.boolean().catch(defaultPreferences.showOrderLines),
        showPositionLine: z.boolean().catch(defaultPreferences.showPositionLine),
        showLiquidationLine: z.boolean().catch(defaultPreferences.showLiquidationLine),
        showMarkPriceChartLine: z.boolean().catch(defaultPreferences.showMarkPriceChartLine),
        isAmountInBase: z.boolean().catch(defaultPreferences.isAmountInBase),
        postOnly: z.boolean().catch(defaultPreferences.postOnly),
        orderDirection: z.enum(OrderDirections),
        currentRfqIds: z
          .record(z.string(), z.record(z.string(), z.number()))
          .catch(defaultPreferences.currentRfqIds),
        rfqOrderBookSnapshots: z
          .record(
            z.string(),
            z.record(
              z.string(),
              z.object({
                asks: z.array(z.object({ price: z.number(), size: z.number() })),
                bids: z.array(z.object({ price: z.number(), size: z.number() })),
              }),
            ),
          )
          .catch(defaultPreferences.rfqOrderBookSnapshots),
        dismissedClaimAmounts: z
          .record(z.string(), z.number())
          .catch(defaultPreferences.dismissedClaimAmounts),
        orderBookGroupBy: z
          .record(z.string(), orderBookMultiplierSchema)
          .catch(defaultPreferences.orderBookGroupBy),
        marketTradesFilterBy: z
          .record(z.string(), z.number())
          .catch(defaultPreferences.marketTradesFilterBy),
        favoriteMarkets: z.array(z.number()).catch(defaultPreferences.favoriteMarkets),
        dateFormatting: z.enum(UserPreferrableDateFormat).catch(defaultPreferences.dateFormatting),
        gainOption: z.union([z.literal('%'), z.literal('$')]).catch(defaultPreferences.gainOption),
        lossOption: z.union([z.literal('%'), z.literal('$')]).catch(defaultPreferences.lossOption),
        mobileLoginL1Address: z.string().catch(defaultPreferences.mobileLoginL1Address),
        authenticatedViaL1Changepubkey: z
          .boolean()
          .catch(defaultPreferences.authenticatedViaL1Changepubkey),
        tableSortingAssetsPortfolio: sortingStateSchema.catch(
          defaultPreferences.tableSortingAssetsPortfolio,
        ),
        tableSortingAssetsPools: sortingStateSchema.catch(
          defaultPreferences.tableSortingAssetsPools,
        ),
        tableSortingPositionsPortfolio: sortingStateSchema.catch(
          defaultPreferences.tableSortingPositionsPortfolio,
        ),
        tableSortingPositionsPools: sortingStateSchema.catch(
          defaultPreferences.tableSortingPositionsPools,
        ),
        tableSortingActiveOrdersPortfolio: sortingStateSchema.catch(
          defaultPreferences.tableSortingActiveOrdersPortfolio,
        ),
        tableSortingActiveOrdersPools: sortingStateSchema.catch(
          defaultPreferences.tableSortingActiveOrdersPools,
        ),
        tableSortingTwapOrdersPortfolio: sortingStateSchema.catch(
          defaultPreferences.tableSortingTwapOrdersPortfolio,
        ),
        tableSortingExplorerMarkets: sortingStateSchema.catch(
          defaultPreferences.tableSortingExplorerMarkets,
        ),
        tableSortingMarketsPage: sortingStateSchema.catch(
          defaultPreferences.tableSortingMarketsPage,
        ),
        tableSortingMarkets: sortingStateSchema.catch(defaultPreferences.tableSortingMarkets),
        tableSortingSpotMarkets: sortingStateSchema.catch(
          defaultPreferences.tableSortingSpotMarkets,
        ),
        tableSortingPublicPools: sortingStateSchema.catch(
          defaultPreferences.tableSortingPublicPools,
        ),
        tableSortingMarketRisk: sortingStateSchema.catch(defaultPreferences.tableSortingMarketRisk),
        maxSlippage: z
          .number()
          .catch(defaultPreferences.maxSlippage)
          .transform((maxSlippage) => Math.min(maxSlippage, MAX_MARKET_ORDER_SLIPPAGE)),
        maxSLTPSlippage: z
          .number()
          .catch(defaultPreferences.maxSLTPSlippage)
          .transform((maxSlippage) => Math.min(maxSlippage, MAX_SLTP_ORDER_SLIPPAGE)),
        conditionalLimitPrefill: z.boolean().catch(defaultPreferences.conditionalLimitPrefill),
        orderType: z.enum(OrderType).catch(defaultPreferences.orderType),
        closePositionOrderType: z.enum(OrderType).catch(defaultPreferences.closePositionOrderType),
        depositCapNotificationDismissed: z
          .boolean()
          .catch(defaultPreferences.depositCapNotificationDismissed),
        customizableEditMode: z.boolean().catch(defaultPreferences.customizableEditMode),
        orderbookFlashAnimation: z.boolean().catch(defaultPreferences.orderbookFlashAnimation),
        backgroundFillNotification: z
          .boolean()
          .catch(defaultPreferences.backgroundFillNotification),
        orderFilledSound: z.boolean().catch(defaultPreferences.orderFilledSound),
        orderFillSoundVariant: z
          .enum(['neutral', 'chime', 'dark', 'palm-muted'])
          .catch(defaultPreferences.orderFillSoundVariant),
        funMode: z.boolean().catch(defaultPreferences.funMode),
        shouldRememberMe: z.boolean().catch(defaultPreferences.shouldRememberMe),
        closedRefundsNotifs: z.array(z.string()).catch(defaultPreferences.closedRefundsNotifs),
        notificationPlacement: z
          .union([z.literal('bottom-right'), z.literal('bottom-left')])
          .catch(defaultPreferences.notificationPlacement),
        portfolioDateSelection: z
          .object({
            statsTimeline: z
              .enum(TIMELINES as [Timeline, ...Timeline[]])
              .catch(defaultPreferences.portfolioDateSelection.statsTimeline),
            chartsTimeline: z
              .enum(TIMELINES as [Timeline, ...Timeline[]])
              .catch(defaultPreferences.portfolioDateSelection.chartsTimeline),
            statsCustomRange: customDateRangeSchema.optional().catch(undefined),
            chartsCustomRange: customDateRangeSchema.optional().catch(undefined),
          })
          .catch(defaultPreferences.portfolioDateSelection),
        publicPoolChartDateSelection: z
          .enum(TIMELINES as [Timeline, ...Timeline[]])
          .catch(defaultPreferences.publicPoolChartDateSelection),
        stakingPoolChartDateSelection: z
          .enum(TIMELINES as [Timeline, ...Timeline[]])
          .catch(defaultPreferences.stakingPoolChartDateSelection),
        publicPoolChartCustomRange: customDateRangeSchema.optional().catch(undefined),
        stakingPoolChartCustomRange: customDateRangeSchema.optional().catch(undefined),
        inviteToastDismissed: z.boolean().catch(defaultPreferences.inviteToastDismissed),
        slWorseThanLiqToastDismissedAt: z
          .number()
          .catch(defaultPreferences.slWorseThanLiqToastDismissedAt),
        showWithdrawalSurvey: z.boolean().catch(defaultPreferences.showWithdrawalSurvey),
        seenFeatureHighlight: z.string().catch(defaultPreferences.seenFeatureHighlight),
        lastAnnouncementDismissed: z.number().catch(defaultPreferences.lastAnnouncementDismissed),
        dismissedMarketAnnouncements: z
          .record(z.string(), z.boolean())
          .catch(defaultPreferences.dismissedMarketAnnouncements),
        hidePnl: z.boolean().catch(defaultPreferences.hidePnl),
        hidePositionSize: z.boolean().catch(defaultPreferences.hidePositionSize),
        hideSmallBalances: z.boolean().catch(defaultPreferences.hideSmallBalances),
        obSetSize: z.boolean().catch(defaultPreferences.obSetSize),
        pinnedInput: z.enum(['base', 'quote', 'percentage']).catch(defaultPreferences.pinnedInput),
        selectedMarketType: z
          .enum(['ALL', 'SPOT', 'PERPS'])
          .catch(defaultPreferences.selectedMarketType),
        selectedMarketCategory: z
          .enum(['ALL', 'FAVORITES', 'CRYPTO', 'SPOT', 'RWA'] as MarketCategory[])
          .catch(defaultPreferences.selectedMarketCategory),
        selectedTokenCategory: z
          .enum(TOKEN_CATEGORY_ORDER as [TokenCategory, ...TokenCategory[]])
          .catch(defaultPreferences.selectedTokenCategory),
        showDirectionBadge: z.boolean().catch(defaultPreferences.showDirectionBadge),
        skipConfirmOrder: z.boolean().catch(defaultPreferences.skipConfirmOrder),
        candlestickResolution: z.string().catch(defaultPreferences.candlestickResolution),
        currentAtomic: z
          .object({
            items: z.array(
              z.object({
                marketId: z.number(),
                percentage: z.union([z.string(), z.number()]).transform(String),
                isAsk: z.number(),
              }),
            ),
          })
          .catch(defaultPreferences.currentAtomic),
        atomicInput: z
          .object({
            orderSize: z.string().catch(defaultPreferences.atomicInput.orderSize),
            sizeType: z.enum(['size', 'percentage']).catch(defaultPreferences.atomicInput.sizeType),
          })
          .catch(defaultPreferences.atomicInput),
        atomicMaxSlippage: z
          .number()
          .catch(defaultPreferences.atomicMaxSlippage)
          .transform((maxSlippage) => Math.min(maxSlippage, MAX_MARKET_ORDER_SLIPPAGE)),
        atomicReduceOnly: z.boolean().catch(defaultPreferences.atomicReduceOnly),
        atomicIsTwap: z.boolean().catch(defaultPreferences.atomicIsTwap),
        atomicAutoBalance: z.boolean().catch(defaultPreferences.atomicAutoBalance),
        resolveEnsNames: z.boolean().catch(defaultPreferences.resolveEnsNames),
      })
      .catch(defaultPreferences),
  })
  .catch({ preferences: defaultPreferences })

export type UserPreferences = z.infer<typeof userPreferencesSchema>['preferences']
export type UserPreferenceKey = keyof UserPreferences

export type PreferencesSlice = {
  preferences: UserPreferences
  setPreference: <T extends UserPreferenceKey>(key: T, value: UserPreferences[T]) => void
  loadPreferences: () => void
}

export const createPreferencesSlice: StateCreator<PreferencesSlice, [], [], PreferencesSlice> = (
  set,
  get,
) => ({
  preferences: defaultPreferences,
  persistenceSet: () => {},
  persistenceGet: () => null,
  setPreference: (key, value) => {
    const newPreferences = { ...get().preferences, [key]: value }
    // setPreference should also save the data
    persistence.setItem('preferences', JSON.stringify(newPreferences))
    set({ preferences: newPreferences })
  },
  loadPreferences: () => {
    const currentStorage = persistence.getItem('preferences') ?? '{}'
    const preferences = JSON.parse(currentStorage) as unknown as Partial<UserPreferences>

    set({ preferences: userPreferencesSchema.parse({ preferences }).preferences })
  },
})
