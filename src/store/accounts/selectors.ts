import { pickBy } from 'lodash-es'
import { OrderTriggerStatusEnum, OrderTypeEnum, RfqRespondStatusEnum } from 'zklighter-perps'

import { DRAFT_RFQ_ID } from '../../constants/order'
import { computeTotalAllocatedMargin } from '../../formulas/common'
import { MarginMode } from '../../types/MarginMode'
import { convertBaseToFloat, isMarketSpot } from '../../utils/common'
import { getDefaultMarketMarginModeFromFlags } from '../../utils/marketFlags'
import {
  selectCurrentMarket,
  selectCurrentMarketId,
  selectOrderBookMeta,
} from '../orderbook/selectors'
import {
  selectAccountIndex,
  selectAssetId,
  selectMarketId,
  selectOrderId,
} from '../params/selectors'
import { selectCurrentRfqIds } from '../preferences/selectors'
import type {
  ActiveRfqIntent,
  AssetBalance,
  Order,
  Position,
  Rfq,
  Share,
  SpotAvgEntryPrice,
  Trade,
} from '../types'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import type { AccountsSlice } from './createAccountsSlice'

const DEFAULT_ACCOUNT_POSITIONS: Record<string, Position> = {}
const DEFAULT_ACTIVE_ORDERS: Record<string, Order[]> = {}
const DEFAULT_ASSET_BALANCES: Record<string, AssetBalance> = {}
const DEFAULT_SPOT_AVG_ENTRY_PRICES: Record<string, SpotAvgEntryPrice> = {}
const DEFAULT_INACTIVE_ORDERS: Record<string, Order[]> = {}
const DEFAULT_TRADES: Record<string, Trade[]> = {}
const DEFAULT_SHARES: Share[] = []
const DEFAULT_RFQS: Record<string, Record<string, Rfq>> = {}

const processAssetBalances = (assetBalances = DEFAULT_ASSET_BALANCES) => assetBalances

const processPositions = (positions = DEFAULT_ACCOUNT_POSITIONS): Record<string, Position> =>
  pickBy(positions, (position) => position.position !== 0)

export const filterIsolatedPositions = (
  positions?: Record<string, Position>,
): Record<string, Position> | undefined =>
  positions ? pickBy(positions, (position) => position.margin_mode === MarginMode.CROSS) : positions

const filterCrossPositions = (
  positions?: Record<string, Position>,
): Record<string, Position> | undefined =>
  positions ? pickBy(positions, (position) => position.margin_mode !== MarginMode.CROSS) : positions

const selectAccounts = (state: AccountsSlice) => state.accounts

export const selectAccountTradingMode = (state: AccountsSlice) => state.accountTradingMode

const selectAccount = createSelector(
  [selectAccounts, selectAccountIndex],
  createTracking('selectAccount', (accounts, accountIndex) => accounts[accountIndex]),
)

const selectAccountRfqs = createSelector(
  [selectAccount],
  createTracking('selectAccountRfqs', (account) => account?.rfqs ?? DEFAULT_RFQS),
)

const resolveCurrentRfq = (
  rfqs: Record<string, Record<string, Rfq>>,
  currentRfqIds: Record<string, Record<string, number>>,
  accountIndex: number,
  marketId: number,
): Rfq | null => rfqs[marketId]?.[currentRfqIds[accountIndex]?.[marketId] ?? DRAFT_RFQ_ID] ?? null

export const selectAccountRfq = createSelector(
  [selectAccountRfqs, selectCurrentRfqIds, selectAccountIndex, selectMarketId],
  createTracking('selectAccountRfq', resolveCurrentRfq),
)

const selectCurrentMarketAccountRfq = createSelector(
  [selectAccountRfqs, selectCurrentRfqIds, selectAccountIndex, selectCurrentMarketId],
  createTracking('selectCurrentMarketAccountRfq', resolveCurrentRfq),
)

export const selectRfqActiveIntent = createSelector(
  [selectCurrentMarketAccountRfq, selectCurrentMarket],
  createTracking('selectRfqActiveIntent', (rfq, currentMarket): ActiveRfqIntent | null => {
    if (!rfq) {
      return null
    }

    const counts = rfq.responses.reduce(
      (acc, entry) => {
        switch (entry.status) {
          case RfqRespondStatusEnum.Acknowledged: {
            acc.acknowledged += 1
            break
          }
          case RfqRespondStatusEnum.LiquidityProvided: {
            acc.acknowledged += 1
            acc.approved += 1
            break
          }
          case RfqRespondStatusEnum.NotInterested: {
            acc.acknowledged += 1
            acc.declined += 1
            break
          }
        }

        return acc
      },
      { acknowledged: 0, approved: 0, declined: 0 },
    )

    return {
      ...counts,
      createdAt: rfq.created_at,
      isShort: rfq.direction === 0,
      marketId: rfq.market_index,
      ...(rfq.base_amount > 0 && {
        baseAmount: convertBaseToFloat(rfq.base_amount, currentMarket.size_decimals).toString(),
      }),
      ...(rfq.quote_amount > 0 && {
        quoteAmount: convertBaseToFloat(
          rfq.quote_amount,
          currentMarket.supported_quote_decimals,
        ).toString(),
      }),
      ...(rfq.id !== DRAFT_RFQ_ID && { rfqId: rfq.id }),
      rfqStatus: rfq.status,
    }
  }),
)

export const selectRawPositions = createSelector(
  [selectAccount],
  createTracking('selectRawPositions', (account) => account?.positions),
)

export const selectPositions = createSelector(
  [selectRawPositions],
  createTracking('selectPositions', processPositions),
)

export const selectCrossPositions = createSelector(
  [selectRawPositions],
  createTracking('selectCrossPositions', filterIsolatedPositions),
)

const selectIsolatedPositions = createSelector(
  [selectRawPositions],
  createTracking('selectIsolatedPositions', filterCrossPositions),
)

export const selectTotalAllocatedMargin = createSelector(
  [selectIsolatedPositions],
  createTracking('selectTotalAllocatedMargin', computeTotalAllocatedMargin),
)

export const selectPosition = createSelector(
  [selectPositions, selectMarketId],
  createTracking('selectPosition', (positions, marketId) => positions[marketId]),
)

export const selectRawPosition = createSelector(
  [selectRawPositions, selectMarketId],
  createTracking('selectRawPosition', (positions, marketId) => positions?.[marketId]),
)

export const selectCurrentMarketPosition = createSelector(
  [selectRawPositions, selectCurrentMarketId],
  createTracking('selectCurrentMarketPosition', (positions, marketId) => positions?.[marketId]),
)

export const selectPositionCount = createSelector(
  [selectPositions],
  createTracking('selectPositionCount', (positions) => Object.keys(positions).length),
)

export const selectRawAssetBalances = createSelector(
  [selectAccount],
  createTracking('selectRawAssetBalances', (account) => account?.assetBalances),
)

export const selectAssetBalances = createSelector(
  [selectRawAssetBalances],
  createTracking('selectAssetBalances', processAssetBalances),
)

export const selectAssetBalance = createSelector(
  [selectAssetBalances, selectAssetId],
  createTracking('selectAssetBalance', (assetBalances, assetId) => assetBalances[assetId]),
)

export const selectSpotAvgEntryPrices = createSelector(
  [selectAccount],
  createTracking(
    'selectSpotAvgEntryPrices',
    (account) => account?.spotAvgEntryPrices ?? DEFAULT_SPOT_AVG_ENTRY_PRICES,
  ),
)

export const selectActiveOrders = createSelector(
  [selectAccount],
  createTracking('selectActiveOrders', (account) => account?.activeOrders ?? DEFAULT_ACTIVE_ORDERS),
)

export const selectActiveOrdersByMarketId = createSelector(
  [selectActiveOrders, selectMarketId],
  createTracking(
    'selectActiveOrdersByMarketId',
    (activeOrders, marketId) => activeOrders[marketId],
  ),
)

export const selectActiveOrder = createSelector(
  [selectActiveOrdersByMarketId, selectOrderId],
  createTracking('selectActiveOrder', (orders, orderId) =>
    orders?.find((order) => order.order_id === orderId),
  ),
)

export const selectInactiveOrders = createSelector(
  [selectAccount],
  createTracking(
    'selectInactiveOrders',
    (account) => account?.inactiveOrders ?? DEFAULT_INACTIVE_ORDERS,
  ),
)

export const selectShares = createSelector(
  [selectAccount],
  createTracking('selectShares', (account) => account?.shares ?? DEFAULT_SHARES),
)

export const selectShareCount = createSelector(
  [selectShares],
  createTracking(
    'selectShareCount',
    (shares) =>
      shares.filter((share) => share.shares_amount > 0 && share.principal_amount > 0).length,
  ),
)

export const selectInactiveOrdersByMarketId = createSelector(
  [selectInactiveOrders, selectMarketId],
  createTracking(
    'selectInactiveOrdersByMarketId',
    (inactiveOrders, marketId) => inactiveOrders[marketId],
  ),
)

export const selectOrderById = createSelector(
  [selectActiveOrders, selectInactiveOrders, selectMarketId, selectOrderId],
  createTracking('selectOrderById', (activeOrders, inactiveOrders, marketId, orderId) =>
    [...(activeOrders[marketId] ?? []), ...(inactiveOrders[marketId] ?? [])].find(
      (order) => order.order_id === orderId,
    ),
  ),
)

export const selectTrades = createSelector(
  [selectAccount],
  createTracking('selectTrades', (account) => account?.trades ?? DEFAULT_TRADES),
)

export const selectMarginMode = createSelector(
  [selectRawPositions, selectOrderBookMeta],
  createTracking('selectMarginMode', (positions, market) => {
    if (isMarketSpot(market)) {
      return MarginMode.CROSS
    }

    return (
      positions?.[market.market_id]?.margin_mode ??
      getDefaultMarketMarginModeFromFlags(market.market_flags)
    )
  }),
)

export const selectWeeklyVolume = createSelector(
  [selectAccount],
  createTracking('selectWeeklyVolume', (account) => account?.weeklyVolume ?? null),
)

export const selectDailyVolume = createSelector(
  [selectAccount],
  createTracking('selectDailyVolume', (account) => account?.dailyVolume ?? null),
)

export const selectMonthlyVolume = createSelector(
  [selectAccount],
  createTracking('selectMonthlyVolume', (account) => account?.monthlyVolume ?? null),
)

export const selectTotalVolume = createSelector(
  [selectAccount],
  createTracking('selectTotalVolume', (account) => account?.totalVolume ?? null),
)

export const selectPublicPoolInfo = createSelector(
  [selectAccount],
  createTracking('selectPublicPoolInfo', (account) => account?.poolInfo),
)

export const selectLivePoints = createSelector(
  [selectAccount],
  createTracking('selectLivePoints', (account) => account?.livePoints ?? null),
)

export const selectPositionsLoading = createSelector(
  [selectAccount],
  createTracking('selectPositionsLoading', (account) => !account?.positions),
)

export const selectAssetBalancesLoading = createSelector(
  [selectAccount],
  createTracking('selectAssetBalancesLoading', (account) => !account?.assetBalances),
)

export const selectActiveOrdersLoading = createSelector(
  [selectAccount],
  createTracking('selectActiveOrdersLoading', (account) => !account?.activeOrders),
)

export const selectInactiveOrdersLoading = createSelector(
  [selectAccount],
  createTracking('selectInactiveOrdersLoading', (account) => !account?.inactiveOrders),
)

export const selectTradesLoading = createSelector(
  [selectAccount],
  createTracking('selectTradesLoading', (account) => !account?.trades),
)

export const selectActiveOrderCount = createSelector(
  [selectActiveOrders],
  createTracking(
    'selectActiveOrderCount',
    (activeOrders) => Object.values(activeOrders).flat().length,
  ),
)

export const selectActiveTwapsCount = createSelector(
  [selectActiveOrders],
  createTracking(
    'selectActiveTwapsCount',
    (activeOrders) =>
      Object.values(activeOrders)
        .flat()
        .filter((o) => o.type === OrderTypeEnum.Twap).length,
  ),
)

export const selectCanModifyMarginMode = createSelector(
  [selectPosition, selectActiveOrdersByMarketId],
  createTracking(
    'selectCanModifyMarginMode',
    (position, activeOrders) => !position && !activeOrders?.length,
  ),
)

export const selectPositionTiedTPandSLOrders = createSelector(
  [selectActiveOrdersByMarketId],
  createTracking('selectPositionTiedTPandSLOrders', (orders) =>
    orders?.filter(
      (order) =>
        (order.type === OrderTypeEnum.StopLoss ||
          order.type === OrderTypeEnum.StopLossLimit ||
          order.type === OrderTypeEnum.TakeProfit ||
          order.type === OrderTypeEnum.TakeProfitLimit) &&
        order.trigger_status === OrderTriggerStatusEnum.MarkPrice,
    ),
  ),
)

export const selectPositionTiedSLOrder = createSelector(
  [selectActiveOrdersByMarketId],
  createTracking('selectPositionTiedSLOrder', (orders) =>
    orders?.find(
      (order) =>
        (order.type === OrderTypeEnum.StopLoss || order.type === OrderTypeEnum.StopLossLimit) &&
        order.trigger_status === OrderTriggerStatusEnum.MarkPrice &&
        order.initial_base_amount === 0,
    ),
  ),
)

export const selectPositionTiedTPOrder = createSelector(
  [selectActiveOrdersByMarketId],
  createTracking('selectPositionTiedTPOrder', (orders) =>
    orders?.find(
      (order) =>
        (order.type === OrderTypeEnum.TakeProfit || order.type === OrderTypeEnum.TakeProfitLimit) &&
        order.trigger_status === OrderTriggerStatusEnum.MarkPrice &&
        order.initial_base_amount === 0,
    ),
  ),
)
