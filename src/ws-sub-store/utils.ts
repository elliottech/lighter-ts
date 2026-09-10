import { mapValues, omit, partition, pickBy, uniqBy } from 'lodash-es'
import { RfqListStatusEnum, TradeTypeEnum } from 'zklighter-perps'
import type { ExtendedCandlestick } from '../store/orderbook/types'
import {
  candleToCandlestick,
  getCandleKey,
  markPriceCandleToCandlestick,
  nextLiveCandlestick,
  withMidPriceOnLiveCandlestick,
  withPreviousRange,
} from '../utils/candlesticks'
import {
  selectAllowedAssetIds,
  selectAllowedMarketIds,
  selectPerpsOrderBookMetas,
} from '../store/orderbook/selectors'
import { useLighterStore } from '../store/useLighterStore'
import type { Account, Tx } from '../store/types'
import type {
  WsAckAgentMessage,
  WsAgentAnsweredQA,
  WsAgentPendingQA,
  WsAssetStats,
  WsErrorMessage,
  WsMessage,
  WsNotification as WsNotificationType,
  WsOrder,
  WsOrderbook,
  WsOrderbookItem,
  WsPerpsMarketStats,
  WsPoolInfo,
  WsPosition,
  WsRfq,
  WsShare,
  WsSpotMarketStats,
  WsSubscribedAccountOrdersMessage,
  WsSubscribedAccountPositionsMessage,
  WsSubscribedAccountTradesMessage,
  WsSubscribedAgentMessage,
  WsSubscribedAssetBalancesMessage,
  WsSubscribedAssetStatsMessage,
  WsSubscribedCandleMessage,
  WsSubscribedHeightMessage,
  WsSubscribedLivePointsMessage,
  WsSubscribedMarkPriceCandleMessage,
  WsSubscribedOrderBookMessage,
  WsSubscribedPerpsMarketStatsMessage,
  WsSubscribedPoolInfoMessage,
  WsSubscribedRfqsMessage,
  WsSubscribedSpotAvgEntryPricesMessage,
  WsSubscribedSpotMarketStatsMessage,
  WsSubscribedTradeMessage,
  WsSubscribeNotificationMessage,
  WsTrade,
  WsUpdateAccountOrdersMessage,
  WsUpdateAccountPositionsMessage,
  WsUpdateAccountTradesMessage,
  WsUpdateAgentMessage,
  WsUpdateAssetBalancesMessage,
  WsUpdateAssetStatsMessage,
  WsUpdateCandleMessage,
  WsUpdateExecutedTransactionMessage,
  WsUpdateHeightMessage,
  WsUpdateLivePointsMessage,
  WsUpdateMarkPriceCandleMessage,
  WsUpdateNotificationMessage,
  WsUpdateOrderBookMessage,
  WsUpdatePerpsMarketStatsMessage,
  WsUpdatePoolInfoMessage,
  WsUpdateRfqsMessage,
  WsUpdateSpotAvgEntryPricesMessage,
  WsUpdateSpotMarketStatsMessage,
  WsUpdateTradeMessage,
} from '../lighter-ws/types/WsMessage'
import { isOrderActive } from '../utils/isOrderActive'
import { setCurrentRfqId } from '../actions/rfq'
import { getMarketDisplayPrice } from '../utils/getMarketDisplayPrice'
import { websocketConfig } from './websocketConfig'
import { MarginMode } from '../types/MarginMode'
import { getDefaultMarketMarginModeFromFlags } from '../utils/marketFlags'
import { DRAFT_RFQ_ID } from '../constants/order'
import {
  EMPTY_AGENT_THREAD,
  type AgentExchange,
  type AgentThread,
} from '../store/agent/createAgentSlice'

const getChannelParts = (channel: string) => channel.split(/[/:]/)

const getMarketIndexFromChannel = (channel: string) => {
  const marketId = Number(getChannelParts(channel)[1])

  return Number.isNaN(marketId) ? -1 : marketId
}

const getCandleResolutionFromChannel = (channel: string) => getChannelParts(channel)[2] ?? ''

const upsertBufferedCandlestick = (candlestick: ExtendedCandlestick) => {
  const key = getCandleKey(candlestick.marketId, candlestick.resolution)
  const group = (bufferedNewCandlesticks[key] ??= [])
  const existingIndex = group.findIndex((buffered) => buffered.time === candlestick.time)

  if (existingIndex >= 0) {
    group[existingIndex] = candlestick
  } else {
    group.push(candlestick)
  }
}

const checkMarketIndexFromChannel = (channel: string, currentId: number) => {
  const marketPart = getChannelParts(channel)[1]

  return marketPart !== 'all' && currentId !== Number(marketPart)
}

const getAccountIndexFromChannel = (channel: string) => {
  const accountIndex = Number(getChannelParts(channel)[1])

  return Number.isNaN(accountIndex) ? 0 : accountIndex
}

const filterUnavailableMarkets = <T>(entity: Record<string, T>) => {
  const allowedIds = selectAllowedMarketIds(useLighterStore.getState())
  return pickBy(entity, (_, key) => allowedIds.has(Number(key)))
}

// Market stats updates arrive frequently, so buffer them in place to avoid
// recreating the full buffered map on every websocket message.
const mergeInPlace = <T>(entity: Record<string, T>, target: Record<string, T>) => {
  const allowedIds = selectAllowedMarketIds(useLighterStore.getState())

  Object.entries(entity).forEach(([key, value]) => {
    if (allowedIds.has(Number(key))) {
      target[key] = value
    }
  })
}

const filterUnavailableAssetIds = <T>(entity: Record<string, T>) => {
  const allowedIds = selectAllowedAssetIds(useLighterStore.getState())
  return pickBy(entity, (_, key) => allowedIds.has(Number(key)))
}

type AccountTxCallback = (tx: Tx) => void

let accountTxCallbacks: AccountTxCallback[] = []

export const subscribeToAccountTx = (callback: AccountTxCallback) =>
  accountTxCallbacks.push(callback)

export const unsubscribeToAccountTx = (callback: AccountTxCallback) =>
  (accountTxCallbacks = accountTxCallbacks.filter((cb) => cb !== callback))

export const handleWsMessage = (
  data: WsMessage,
  triggerWsNotification: (notif: WsNotificationType) => void,
) => {
  switch (data.type) {
    case 'subscribed/order_book':
      return handleSubscribedOrderBook(data)
    case 'update/order_book':
      return handleUpdateOrderBook(data)
    case 'subscribed/trade_fe':
      return handleSubscribedTrade(data)
    case 'update/trade_fe':
      return handleUpdateTrade(data)
    case 'subscribed/candle':
      return handleSubscribedCandle(data)
    case 'update/candle':
      return handleUpdateCandle(data)
    case 'subscribed/mark_price_candle':
      return handleSubscribedMarkPriceCandle(data)
    case 'update/mark_price_candle':
      return handleUpdateMarkPriceCandle(data)
    case 'subscribed/market_stats':
      return handleSubscribedPerpsMarketStats(data)
    case 'update/market_stats':
      return handleUpdatePerpsMarketStats(data)
    case 'subscribed/spot_market_stats':
      return handleSubscribedSpotMarketStats(data)
    case 'update/spot_market_stats':
      return handleUpdateSpotMarketStats(data)
    case 'subscribed/asset_stats':
      return handleSubscribedAssetStats(data)
    case 'update/asset_stats':
      return handleUpdateAssetStats(data)
    case 'subscribed/account_all_trades':
      return handleSubscribedAccountTrades(data)
    case 'update/account_all_trades':
      return handleUpdateAccountTrades(data)
    case 'subscribed/account_all_positions_fe':
      return handleSubscribedAccountPositions(data)
    case 'update/account_all_positions_fe':
      return handleUpdateAccountPositions(data)
    case 'subscribed/account_all_orders':
      return handleSubscribedAccountOrders(data)
    case 'update/account_all_orders':
      return handleUpdateAccountOrders(data)
    case 'subscribed/account_all_assets':
      return handleSubscribedAssetBalances(data)
    case 'update/account_all_assets':
      return handleUpdateAssetBalances(data)
    case 'subscribed/account_spot_avg_entry_prices':
      return handleSubscribedSpotAvgEntryPrices(data)
    case 'update/account_spot_avg_entry_prices':
      return handleUpdateSpotAvgEntryPrices(data)
    case 'subscribed/live_points':
      return handleSubscribedLivePoints(data)
    case 'update/live_points':
      return handleUpdateLivePoints(data)
    case 'subscribed/rfq':
      return handleSubscribedRfqs(data)
    case 'update/rfq':
      return handleUpdateRfqs(data)
    case 'subscribed/agent':
      return handleSubscribedAgent(data)
    case 'ack/agent':
      return handleAckAgent(data)
    case 'update/agent':
      return handleUpdateAgent(data)
    case 'update/account_tx':
      return handleUpdateAccountTx(data)
    case 'subscribed/pool_info':
      return handleSubscribedPoolInfo(data)
    case 'update/pool_info':
      return handleUpdatePoolInfo(data)
    case 'subscribed/height':
      return handleSubscribedHeight(data)
    case 'update/height':
      return handleUpdatedHeight(data)
    case 'subscribed/notification':
      return handleSubscribeNotification(data, triggerWsNotification)
    case 'update/notification':
      return handleUpdateNotification(data, triggerWsNotification)
    case 'connected':
      console.log(`Websocket session id: ${data.session_id}`)
      return
    case undefined:
      return handleWsError(data)
    default:
      return
  }
}

let currentMarketId = -1
let bufferedOrderbook: WsOrderbook = { asks: [], bids: [] }
let bufferedTrades: WsTrade[] = []
let bufferedNewCandlesticks: Record<string, ExtendedCandlestick[]> = {}
let bufferedLiquidationTrades: WsTrade[] = []
let bufferedPerpsMarketsStats: Record<string, WsPerpsMarketStats> = {}
let bufferedSpotMarketsStats: Record<string, WsSpotMarketStats> = {}
let bufferedAssetsStats: Record<string, WsAssetStats> = {}
let bufferedPoolInfo: Record<number, WsPoolInfo> = {}
let bufferedLivePoints: Record<number, number> = {}
let bufferedBlockHeight: number | null = null
let perpsMarketsStatsTimestamp = 0
let spotMarketsStatsTimestamp = 0

const updateBufferedNewCandlesticks = (data: WsSubscribedCandleMessage | WsUpdateCandleMessage) => {
  const marketId = getMarketIndexFromChannel(data.channel)
  const resolution = getCandleResolutionFromChannel(data.channel)

  if (!data.candles.length) {
    return
  }

  const showRawPrices = useLighterStore.getState().preferences.showRawPrices
  data.candles.forEach((candle) => {
    upsertBufferedCandlestick(candleToCandlestick(candle, marketId, resolution, showRawPrices))
  })
}

const updateBufferedNewMarkPriceCandlesticks = (
  data: WsSubscribedMarkPriceCandleMessage | WsUpdateMarkPriceCandleMessage,
) => {
  const marketId = getMarketIndexFromChannel(data.channel)
  const resolution = getCandleResolutionFromChannel(data.channel)

  if (!data.candles.length) {
    return
  }

  data.candles.forEach((candle) => {
    upsertBufferedCandlestick(markPriceCandleToCandlestick(candle, marketId, resolution))
  })
}

const reduceOneSideOrderbook = (
  newItems: WsOrderbookItem[],
  previousItems: WsOrderbookItem[],
  asc: boolean,
  filterZeroSizes: boolean = true,
) => {
  // During buffered updates we want to keep zeros in the array until they will remove the entry in the final ordarbook
  // If we remove them here, the final orderbook will not have removed these zeros and will have extra entries
  const mergedItems = Array.from<WsOrderbookItem>({
    length: newItems.length + previousItems.length,
  })
  let previousIndex = 0
  let newIndex = 0
  let mergedIndex = 0

  // Merge both arrays while maintaining order
  while (previousIndex < previousItems.length || newIndex < newItems.length) {
    if (previousIndex >= previousItems.length) {
      // only new items left
      newIndex++
      if (filterZeroSizes && newItems[newIndex - 1]!.size === 0) continue
      mergedItems[mergedIndex++] = newItems[newIndex - 1]!
    } else if (newIndex >= newItems.length) {
      // only previous items left
      previousIndex++
      if (filterZeroSizes && previousItems[previousIndex - 1]!.size === 0) continue
      mergedItems[mergedIndex++] = previousItems[previousIndex - 1]!
    } else {
      // both items present, compare prices
      const previousItem = previousItems[previousIndex]!
      const newItem = newItems[newIndex]!
      if (previousItem.price === newItem.price) {
        previousIndex++
        newIndex++
        if (filterZeroSizes && newItem.size === 0) continue
        mergedItems[mergedIndex++] = newItem
      } else if (asc ? previousItem.price < newItem.price : previousItem.price > newItem.price) {
        previousIndex++
        if (filterZeroSizes && previousItem.size === 0) continue
        mergedItems[mergedIndex++] = previousItem
      } else {
        newIndex++
        if (filterZeroSizes && newItem.size === 0) continue
        mergedItems[mergedIndex++] = newItem
      }
    }
  }
  mergedItems.length = mergedIndex // mutate mergedItems to the actual size since its a new array anyways
  return mergedItems
}

const reduceOrderbook = (
  newOrderbook: WsOrderbook,
  previousOrderbook: WsOrderbook = { asks: [], bids: [] },
  isBuffer: boolean = false,
) => {
  return {
    asks: reduceOneSideOrderbook(newOrderbook.asks, previousOrderbook.asks, true, !isBuffer),
    bids: reduceOneSideOrderbook(newOrderbook.bids, previousOrderbook.bids, false, !isBuffer),
  }
}

const reduceTrades = (newTrades: WsTrade[], previousTrades: WsTrade[] = []) =>
  [
    ...newTrades.filter(
      (trade) => trade.type === TradeTypeEnum.Trade || trade.type === TradeTypeEnum.Liquidation,
    ),
    ...previousTrades,
  ].slice(0, 100)

const reduceLiquidationTrades = (
  newLiquidationTrades: WsTrade[],
  previousLiquidationTrades: WsTrade[] = [],
) => [...newLiquidationTrades, ...previousLiquidationTrades].slice(0, 100)

type LiveMidPrice = { price: number; timestamp: number }

const reduceNewCandlesticks = (
  bufferedCandlesticksByKey: Record<string, ExtendedCandlestick[]>,
  previousCandlesticksByKey: Record<string, ExtendedCandlestick[]>,
  getMidPrice: ((marketId: number) => LiveMidPrice) | undefined,
): Record<string, ExtendedCandlestick[]> | null => {
  let nextCandlesticksByKey: Record<string, ExtendedCandlestick[]> | null = null
  const setCandlesticks = (key: string, candlesticks: ExtendedCandlestick[]) => {
    nextCandlesticksByKey ??= { ...previousCandlesticksByKey }
    nextCandlesticksByKey[key] = candlesticks
  }

  Object.entries(bufferedCandlesticksByKey).forEach(([key, group]) => {
    const candlesticks = group.sort((a, b) => a.time - b.time)
    if (!getMidPrice) {
      setCandlesticks(key, candlesticks)
      return
    }
    const previousCandlesticks = previousCandlesticksByKey[key]
    const previousLiveCandlestick = previousCandlesticks?.[previousCandlesticks.length - 1]
    const lastCandlestick = candlesticks[candlesticks.length - 1]!
    const midPrice = getMidPrice(lastCandlestick.marketId)
    setCandlesticks(
      key,
      withMidPriceOnLiveCandlestick(
        candlesticks.map((candlestick) => withPreviousRange(candlestick, previousLiveCandlestick)),
        midPrice.price,
        midPrice.timestamp,
      ),
    )
  })

  if (!getMidPrice) {
    return nextCandlesticksByKey
  }

  Object.entries(previousCandlesticksByKey).forEach(([key, candlesticks]) => {
    const lastCandlestick = candlesticks[candlesticks.length - 1]
    if (bufferedCandlesticksByKey[key] || !lastCandlestick) {
      return
    }
    const midPrice = getMidPrice(lastCandlestick.marketId)
    const liveCandlestick = nextLiveCandlestick(lastCandlestick, midPrice.price, midPrice.timestamp)
    if (liveCandlestick) {
      setCandlesticks(key, [liveCandlestick])
    }
  })

  return nextCandlesticksByKey
}

const reducePerpsMarketsStats = (
  newPerpsMarketsStats: Record<string, WsPerpsMarketStats>,
  previousPrepsMarketsStats: Record<string, WsPerpsMarketStats>,
) => ({ ...previousPrepsMarketsStats, ...newPerpsMarketsStats })

const reduceSpotMarketsStats = (
  newSpotMarketsStats: Record<string, WsSpotMarketStats>,
  previousSpotMarketsStats: Record<string, WsSpotMarketStats>,
) => ({ ...previousSpotMarketsStats, ...newSpotMarketsStats })

const reduceAssetsStats = (
  newAssetsStats: Record<string, WsAssetStats>,
  previousAssetsStats: Record<string, WsAssetStats>,
) => ({ ...previousAssetsStats, ...newAssetsStats })

const reduceAccountOrders = (account: Account | undefined, orders: Record<string, WsOrder[]>) => {
  const newAccount = { ...account }
  newAccount.activeOrders = { ...newAccount.activeOrders }
  newAccount.inactiveOrders = { ...newAccount.inactiveOrders }

  Object.keys(orders).forEach((marketId) => {
    const oldActiveOrders = newAccount.activeOrders![marketId] ?? []
    const oldInactiveOrders = newAccount.inactiveOrders![marketId] ?? []
    const newOrders = orders[marketId] ?? []

    const [newActiveOrders, newInactiveOrders] = partition(newOrders, (order) => {
      if (isOrderActive(order)) {
        return true
      }

      return false
    })

    const inactiveOrderIDs = new Set(newInactiveOrders.map((order) => order.order_id))
    newAccount.activeOrders![marketId] = uniqBy(
      [
        // Prioritize new orders to handle modifications correctly (uniqBy keeps first occurrence)
        // Exclude orders that became inactive in this update
        ...newActiveOrders.filter((order) => !inactiveOrderIDs.has(order.order_id)),
        // Include old active orders, excluding those that became inactive
        ...oldActiveOrders.filter((order) => !inactiveOrderIDs.has(order.order_id)),
      ],
      'order_id',
    )
    newAccount.inactiveOrders![marketId] = uniqBy(
      [...newInactiveOrders, ...oldInactiveOrders],
      'order_id',
    ).slice(0, 50)
  })
  return newAccount
}

const reduceAccountTrades = (account: Account | undefined, trades: Record<string, WsTrade[]>) => {
  const newAccount = { ...account }
  newAccount.trades = { ...newAccount.trades }
  newAccount.weeklyVolume ??= 0
  newAccount.monthlyVolume ??= 0
  newAccount.totalVolume ??= 0
  newAccount.dailyVolume ??= 0

  Object.keys(trades).forEach((marketId) => {
    const oldMarketTrades = newAccount.trades![marketId] ?? []
    const newMarketTrades = trades[marketId] ?? []
    const marketUpdatedVolume = newMarketTrades.reduce((acc, trade) => acc + trade.usd_amount, 0)

    newAccount.trades![marketId] = [...newMarketTrades, ...oldMarketTrades].slice(0, 50)

    newAccount.weeklyVolume! += marketUpdatedVolume
    newAccount.monthlyVolume! += marketUpdatedVolume
    newAccount.totalVolume! += marketUpdatedVolume
    newAccount.dailyVolume! += marketUpdatedVolume
  })
  return newAccount
}

const reduceAccountVolume = (
  account: Account | undefined,
  weeklyVolume: number,
  monthlyVolume: number,
  totalVolume: number,
  dailyVolume: number,
) => {
  const newAccount = { ...account }
  newAccount.weeklyVolume = weeklyVolume
  newAccount.monthlyVolume = monthlyVolume
  newAccount.totalVolume = totalVolume
  newAccount.dailyVolume = dailyVolume
  return newAccount
}

const reduceAccountPositions = (
  account: Account | undefined,
  positions: Record<string, Omit<WsPosition, 'total_funding_paid_out' | 'total_discount'>>,
  lastFundingRound?: Record<string, number>,
  lastFundingDiscount?: Record<string, number>,
) => {
  const newAccount = { ...account }
  newAccount.positions = { ...newAccount.positions }

  Object.keys(positions).forEach((marketId) => {
    const oldPosition = newAccount.positions![marketId]
    const newPosition = positions[marketId]!

    // if position size is 0 or changes side, we need to reset total_funding_paid_out
    if (!newPosition.position || (oldPosition && newPosition.sign !== oldPosition.sign)) {
      newAccount.positions![marketId] = {
        ...newPosition,
        total_funding_paid_out: 0,
        total_discount: 0,
      }
    } else {
      newAccount.positions![marketId] = {
        ...oldPosition,
        ...newPosition,
        total_funding_paid_out: oldPosition?.total_funding_paid_out ?? 0,
        total_discount: oldPosition?.total_discount ?? 0,
      }
    }
  })

  Object.entries(lastFundingRound ?? {}).forEach(([marketId, newFunding]) => {
    if (newAccount.positions![marketId]) {
      newAccount.positions![marketId].total_funding_paid_out += newFunding
    }
  })

  Object.entries(lastFundingDiscount ?? {}).forEach(([marketId, newDiscount]) => {
    if (newAccount.positions![marketId]) {
      newAccount.positions![marketId].total_discount += newDiscount
    }
  })
  return newAccount
}

const reduceAccountShares = (account: Account | undefined, shares: WsShare[]) => {
  const newAccount = { ...account }
  newAccount.shares = [...(newAccount.shares ?? [])]

  shares.forEach((share) => {
    const existentShare = newAccount.shares!.find(
      ({ public_pool_index }) => public_pool_index === share.public_pool_index,
    )

    if (!existentShare) {
      return newAccount.shares!.push(share)
    }

    existentShare.shares_amount = share.shares_amount
    existentShare.principal_amount = share.principal_amount
  })

  newAccount.shares = newAccount.shares.filter((share) => share.shares_amount !== 0)

  return newAccount
}

const reduceAccountRfqs = (account: Account | undefined, rfqs: WsRfq[], accountIndex: number) => {
  const newAccount = { ...account }
  newAccount.rfqs = { ...newAccount.rfqs }

  rfqs.forEach((rfq) => {
    if (rfq.account_index !== accountIndex) {
      return
    }

    const marketRfqs = { ...newAccount.rfqs![rfq.market_index] }
    const existing = marketRfqs[rfq.id]

    if (rfq.status === RfqListStatusEnum.OrderCreated) {
      delete marketRfqs[rfq.id]
      newAccount.rfqs![rfq.market_index] = marketRfqs
      return
    }

    if (rfq.status === RfqListStatusEnum.Closed && !existing) {
      return
    }

    marketRfqs[rfq.id] = rfq
    newAccount.rfqs![rfq.market_index] = marketRfqs
  })
  return newAccount
}

const clearDanglingRfqPointers = (accountIndex: number) => {
  const state = useLighterStore.getState()
  const accountRfqIds = state.preferences.currentRfqIds[accountIndex]
  if (!accountRfqIds) {
    return
  }

  const rfqs = state.accounts[accountIndex]?.rfqs
  Object.entries(accountRfqIds).forEach(([marketIndex, rfqId]) => {
    if (!rfqs?.[marketIndex]?.[rfqId]) {
      setCurrentRfqId(Number(marketIndex), null)
    }
  })
}

let throttledDataIntervalId: NodeJS.Timeout | null = null

const ensureThrottledDataPush = () => {
  if (throttledDataIntervalId !== null) {
    return
  }

  throttledDataIntervalId = setInterval(() => {
    const hasTradeUpdates = bufferedTrades.length > 0
    const hasLiquidationTradesUpdates = bufferedLiquidationTrades.length > 0
    const hasOrderbookUpdates =
      bufferedOrderbook.asks.length > 0 || bufferedOrderbook.bids.length > 0
    const hasPerpsStatsUpdates = Object.keys(bufferedPerpsMarketsStats).length > 0
    const hasSpotStatsUpdates = Object.keys(bufferedSpotMarketsStats).length > 0
    const hasAssetStatsUpdates = Object.keys(bufferedAssetsStats).length > 0
    const hasPoolInfoUpdates = Object.keys(bufferedPoolInfo).length > 0
    const hasLivePointsUpdates = Object.keys(bufferedLivePoints).length > 0
    const hasHeightUpdate = bufferedBlockHeight !== null

    const state = useLighterStore.getState()
    const perpsMarketsStats = hasPerpsStatsUpdates
      ? reducePerpsMarketsStats(bufferedPerpsMarketsStats, state.perpsMarketsStats)
      : state.perpsMarketsStats
    const spotMarketsStats = hasSpotStatsUpdates
      ? reduceSpotMarketsStats(bufferedSpotMarketsStats, state.spotMarketsStats)
      : state.spotMarketsStats
    const nextNewCandlesticksByKey = reduceNewCandlesticks(
      bufferedNewCandlesticks,
      state.newCandlesticksByKey,
      state.preferences.showMarkPriceCandles
        ? undefined
        : (marketId) =>
            perpsMarketsStats[marketId]
              ? {
                  price: getMarketDisplayPrice(perpsMarketsStats[marketId]),
                  timestamp: perpsMarketsStatsTimestamp,
                }
              : {
                  price: getMarketDisplayPrice(spotMarketsStats[marketId]),
                  timestamp: spotMarketsStatsTimestamp,
                },
    )
    const hasNewCandlestickUpdates = nextNewCandlesticksByKey !== null

    const hasAnyUpdates =
      hasTradeUpdates ||
      hasLiquidationTradesUpdates ||
      hasNewCandlestickUpdates ||
      hasOrderbookUpdates ||
      hasPerpsStatsUpdates ||
      hasSpotStatsUpdates ||
      hasAssetStatsUpdates ||
      hasPoolInfoUpdates ||
      hasLivePointsUpdates ||
      hasHeightUpdate

    // No buffered data — skip setState to avoid creating new object references
    if (!hasAnyUpdates) {
      return
    }

    useLighterStore.setState((prevState) => {
      let newAccounts = prevState.accounts
      if (hasPoolInfoUpdates || hasLivePointsUpdates) {
        newAccounts = {
          ...newAccounts,
        }
        Object.entries(bufferedPoolInfo).forEach(([accountIndex, poolInfo]) => {
          newAccounts[Number(accountIndex)] = {
            ...newAccounts[Number(accountIndex)],
            poolInfo: poolInfo,
          }
        })
        Object.entries(bufferedLivePoints).forEach(([accountIndex, livePoints]) => {
          newAccounts[Number(accountIndex)] = {
            ...newAccounts[Number(accountIndex)],
            livePoints,
          }
        })
      }
      return {
        ...(hasOrderbookUpdates &&
          prevState.orderBook && {
            orderBook: reduceOrderbook(bufferedOrderbook, prevState.orderBook),
          }),
        ...(hasTradeUpdates && {
          trades: reduceTrades(bufferedTrades, prevState.trades ?? undefined),
        }),
        ...(hasLiquidationTradesUpdates && {
          liquidationTrades: reduceLiquidationTrades(
            bufferedLiquidationTrades,
            prevState.liquidationTrades ?? undefined,
          ),
        }),
        ...(nextNewCandlesticksByKey && { newCandlesticksByKey: nextNewCandlesticksByKey }),
        ...(hasPerpsStatsUpdates && { perpsMarketsStats }),
        ...(hasSpotStatsUpdates && { spotMarketsStats }),
        ...(hasAssetStatsUpdates && {
          assetsStats: reduceAssetsStats(bufferedAssetsStats, prevState.assetsStats),
        }),
        ...((hasPoolInfoUpdates || hasLivePointsUpdates) && { accounts: newAccounts }),
        ...(hasHeightUpdate && { height: bufferedBlockHeight }),
      }
    })

    bufferedOrderbook = { asks: [], bids: [] }
    bufferedTrades = []
    bufferedLiquidationTrades = []
    bufferedNewCandlesticks = {}
    bufferedPerpsMarketsStats = {}
    bufferedSpotMarketsStats = {}
    bufferedAssetsStats = {}
    bufferedPoolInfo = {}
    bufferedLivePoints = {}
    bufferedBlockHeight = null
  }, websocketConfig.throttleInterval)
}

const handleSubscribedOrderBook = (data: WsSubscribedOrderBookMessage) => {
  if (checkMarketIndexFromChannel(data.channel, currentMarketId)) {
    return
  }

  useLighterStore.setState({ orderBook: reduceOrderbook(data.order_book) })
  bufferedOrderbook = { asks: [], bids: [] }

  ensureThrottledDataPush()
}

const handleUpdateOrderBook = (data: WsUpdateOrderBookMessage) => {
  if (checkMarketIndexFromChannel(data.channel, currentMarketId)) {
    return
  }
  bufferedOrderbook = reduceOrderbook(data.order_book, bufferedOrderbook, true)
}

const handleSubscribedTrade = (data: WsSubscribedTradeMessage) => {
  if (checkMarketIndexFromChannel(data.channel, currentMarketId)) {
    return
  }

  useLighterStore.setState({
    trades: reduceTrades(data.trades ?? []),
    liquidationTrades: reduceLiquidationTrades(data.liquidation_trades ?? []),
  })
  bufferedTrades = []
  bufferedLiquidationTrades = []

  ensureThrottledDataPush()
}

const handleSubscribedCandle = (data: WsSubscribedCandleMessage) => {
  updateBufferedNewCandlesticks(data)
  ensureThrottledDataPush()
}

const handleUpdateCandle = (data: WsUpdateCandleMessage) => {
  updateBufferedNewCandlesticks(data)
}

const handleSubscribedMarkPriceCandle = (data: WsSubscribedMarkPriceCandleMessage) => {
  updateBufferedNewMarkPriceCandlesticks(data)
  ensureThrottledDataPush()
}

const handleUpdateMarkPriceCandle = (data: WsUpdateMarkPriceCandleMessage) => {
  updateBufferedNewMarkPriceCandlesticks(data)
}

const handleUpdateTrade = (data: WsUpdateTradeMessage) => {
  if (checkMarketIndexFromChannel(data.channel, currentMarketId)) {
    return
  }

  bufferedTrades = reduceTrades(data.trades, bufferedTrades ?? undefined)
  bufferedLiquidationTrades = reduceLiquidationTrades(
    data.liquidation_trades ?? [],
    bufferedLiquidationTrades ?? undefined,
  )
}

const handleSubscribedPerpsMarketStats = (data: WsSubscribedPerpsMarketStatsMessage) => {
  useLighterStore.setState(() => ({
    perpsMarketsStats: filterUnavailableMarkets(data.market_stats),
  }))

  bufferedPerpsMarketsStats = {}
  perpsMarketsStatsTimestamp = data.timestamp
  ensureThrottledDataPush()
}

const handleUpdatePerpsMarketStats = (data: WsUpdatePerpsMarketStatsMessage) => {
  mergeInPlace(data.market_stats, bufferedPerpsMarketsStats)
  perpsMarketsStatsTimestamp = data.timestamp
}

const handleSubscribedSpotMarketStats = (data: WsSubscribedSpotMarketStatsMessage) => {
  useLighterStore.setState(() => ({
    spotMarketsStats: filterUnavailableMarkets(data.spot_market_stats),
  }))

  bufferedSpotMarketsStats = {}
  spotMarketsStatsTimestamp = data.timestamp
  ensureThrottledDataPush()
}

const handleUpdateSpotMarketStats = (data: WsUpdateSpotMarketStatsMessage) => {
  mergeInPlace(data.spot_market_stats, bufferedSpotMarketsStats)
  spotMarketsStatsTimestamp = data.timestamp
}

const handleSubscribedAssetStats = (data: WsSubscribedAssetStatsMessage) => {
  useLighterStore.setState(() => ({ assetsStats: filterUnavailableAssetIds(data.asset_stats) }))

  bufferedAssetsStats = {}
  ensureThrottledDataPush()
}

const handleUpdateAssetStats = (data: WsUpdateAssetStatsMessage) => {
  bufferedAssetsStats = reduceAssetsStats(
    filterUnavailableAssetIds(data.asset_stats),
    bufferedAssetsStats,
  )
}

const handleSubscribedAccountTrades = (data: WsSubscribedAccountTradesMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...reduceAccountVolume(
          prevState.accounts[accountIndex],
          data.weekly_volume,
          data.monthly_volume,
          data.total_volume,
          data.daily_volume,
        ),
        trades: {},
      },
    },
  }))
}

const handleUpdateAccountTrades = (data: WsUpdateAccountTradesMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: reduceAccountTrades(
        prevState.accounts[accountIndex],
        filterUnavailableMarkets(data.trades),
      ),
    },
  }))
}

const handleSubscribedAccountPositions = (
  data: Omit<WsSubscribedAccountPositionsMessage, 'type'>,
) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)
  const perpsOrderBookMetas = selectPerpsOrderBookMetas(useLighterStore.getState())

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...prevState.accounts[accountIndex],
        positions: mapValues(filterUnavailableMarkets(data.positions), (position) => {
          if (position.margin_set_flag || position.margin_mode !== MarginMode.CROSS) {
            return position
          }

          const marketFlags = perpsOrderBookMetas[position.market_id]?.market_flags ?? null

          if (marketFlags === null) {
            return position
          }

          return { ...position, margin_mode: getDefaultMarketMarginModeFromFlags(marketFlags) }
        }),
        shares: data.shares,
      },
    },
  }))
}

const handleUpdateAccountPositions = (data: Omit<WsUpdateAccountPositionsMessage, 'type'>) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: reduceAccountShares(
        reduceAccountPositions(
          prevState.accounts[accountIndex],
          filterUnavailableMarkets(data.positions),
          data.last_funding_round,
          data.last_funding_discount,
        ),
        data.shares,
      ),
    },
  }))
}

const handleSubscribedAccountOrders = (data: WsSubscribedAccountOrdersMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: reduceAccountOrders(
        { ...prevState.accounts[accountIndex], inactiveOrders: {}, activeOrders: {} },
        filterUnavailableMarkets(data.orders),
      ),
    },
  }))
}

const handleUpdateAccountOrders = (data: WsUpdateAccountOrdersMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: reduceAccountOrders(
        prevState.accounts[accountIndex],
        filterUnavailableMarkets(data.orders),
      ),
    },
  }))
}

const handleSubscribedAssetBalances = (data: WsSubscribedAssetBalancesMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...prevState.accounts[accountIndex],
        assetBalances: filterUnavailableAssetIds(data.assets),
      },
    },
  }))
}

const handleUpdateAssetBalances = (data: WsUpdateAssetBalancesMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...prevState.accounts[accountIndex],
        assetBalances: {
          ...prevState.accounts[accountIndex]?.assetBalances,
          ...filterUnavailableAssetIds(data.assets),
        },
      },
    },
  }))
}

const handleSubscribedSpotAvgEntryPrices = (data: WsSubscribedSpotAvgEntryPricesMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...prevState.accounts[accountIndex],
        spotAvgEntryPrices: filterUnavailableAssetIds(data.avg_entry_prices),
      },
    },
  }))
}

const handleUpdateSpotAvgEntryPrices = (data: WsUpdateSpotAvgEntryPricesMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...prevState.accounts[accountIndex],
        spotAvgEntryPrices: {
          ...prevState.accounts[accountIndex]?.spotAvgEntryPrices,
          ...filterUnavailableAssetIds(data.avg_entry_prices),
        },
      },
    },
  }))
}

const handleSubscribedLivePoints = (data: WsSubscribedLivePointsMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  bufferedLivePoints = {}
  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...prevState.accounts[accountIndex],
        livePoints: data.total_live_points,
      },
    },
  }))

  ensureThrottledDataPush()
}

const handleUpdateLivePoints = (data: WsUpdateLivePointsMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)
  bufferedLivePoints[accountIndex] = data.total_live_points
}

const handleSubscribedRfqs = (data: WsSubscribedRfqsMessage) => {
  const accountIndex = useLighterStore.getState().accountIndex

  useLighterStore.setState((prevState) => {
    const prevAccount = prevState.accounts[accountIndex]
    const drafts = pickBy(
      mapValues(prevAccount?.rfqs, (marketRfqs) =>
        pickBy(marketRfqs, (rfq) => rfq.id === DRAFT_RFQ_ID),
      ),
      (marketRfqs) => Object.keys(marketRfqs).length > 0,
    )

    return {
      accounts: {
        ...prevState.accounts,
        [accountIndex]: reduceAccountRfqs(
          { ...prevAccount, rfqs: drafts },
          data.rfqs,
          accountIndex,
        ),
      },
    }
  })

  clearDanglingRfqPointers(accountIndex)
}

const handleUpdateRfqs = (data: WsUpdateRfqsMessage) => {
  const accountIndex = useLighterStore.getState().accountIndex

  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: reduceAccountRfqs(prevState.accounts[accountIndex], data.rfqs, accountIndex),
    },
  }))

  clearDanglingRfqPointers(accountIndex)
}

const AGENT_DISABLED_CODE = 66001
const AGENT_NOT_WHITELISTED_CODE = 66002
const AGENT_LAST_ERROR_CODE = 66999
const INTERNAL_ERROR_CODE = 29500

const isAgentErrorCode = (code: number) =>
  code === INTERNAL_ERROR_CODE || (code >= AGENT_DISABLED_CODE && code <= AGENT_LAST_ERROR_CODE)

const isAgentExchangeInFlight = (exchange: AgentExchange) =>
  exchange.status === 'sending' || exchange.status === 'thinking'

export const newAgentExchangeId = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

const updateAgentThread = (accountIndex: number, update: (thread: AgentThread) => AgentThread) =>
  useLighterStore.setState((prevState) => ({
    agentThreads: {
      ...prevState.agentThreads,
      [accountIndex]: update(prevState.agentThreads[accountIndex] ?? EMPTY_AGENT_THREAD),
    },
  }))

const patchInFlight = (exchanges: AgentExchange[], patch: Partial<AgentExchange>) =>
  exchanges.map((exchange) =>
    isAgentExchangeInFlight(exchange) ? { ...exchange, ...patch } : exchange,
  )

export const patchInFlightAgentExchanges = (accountIndex: number, patch: Partial<AgentExchange>) =>
  updateAgentThread(accountIndex, (thread) => ({
    ...thread,
    exchanges: patchInFlight(thread.exchanges, patch),
  }))

export const appendAgentExchange = (accountIndex: number, exchange: AgentExchange) =>
  updateAgentThread(accountIndex, (thread) => ({
    ...thread,
    exchanges: [...thread.exchanges, exchange],
  }))

export const clearAgentThread = (accountIndex: number) =>
  useLighterStore.setState((prevState) => ({
    agentThreads: omit(prevState.agentThreads, accountIndex),
  }))

export const failInFlightAgentExchanges = () =>
  useLighterStore.setState((prevState) => ({
    agentThreads: mapValues(prevState.agentThreads, (thread) => ({
      ...thread,
      exchanges: patchInFlight(thread.exchanges, { error: null, status: 'failed' }),
    })),
  }))

const replayedAgentExchanges = ({ history, pending }: WsSubscribedAgentMessage) => {
  const answeredExchange = (qa: WsAgentAnsweredQA): AgentExchange => ({
    answer: qa.answer,
    answeredAt: qa.timestamp,
    askedAt: qa.timestamp,
    error: null,
    id: newAgentExchangeId(),
    question: qa.question,
    status: 'answered',
  })

  const pendingExchange = (qa: WsAgentPendingQA): AgentExchange => ({
    answer: null,
    answeredAt: null,
    askedAt: qa.timestamp,
    error: null,
    id: newAgentExchangeId(),
    question: qa.question,
    status: 'thinking',
  })

  const replayed = history.map(answeredExchange)

  if (pending) {
    replayed.push(pendingExchange(pending))
  }

  return replayed
}

const handleSubscribedAgent = (data: WsSubscribedAgentMessage) =>
  updateAgentThread(getAccountIndexFromChannel(data.channel), () => ({
    exchanges: replayedAgentExchanges(data),
    isUnauthorized: false,
  }))

const handleAckAgent = (data: WsAckAgentMessage) =>
  patchInFlightAgentExchanges(getAccountIndexFromChannel(data.channel), { status: 'thinking' })

const handleUpdateAgent = (data: WsUpdateAgentMessage) =>
  patchInFlightAgentExchanges(getAccountIndexFromChannel(data.channel), {
    answer: data.answer,
    answeredAt: Date.now(),
    status: 'answered',
  })

const handleWsError = ({ error }: WsErrorMessage) => {
  if (!error?.code || !isAgentErrorCode(error.code)) return

  const isUnauthorized =
    error.code === AGENT_DISABLED_CODE || error.code === AGENT_NOT_WHITELISTED_CODE
  const { accountIndex } = useLighterStore.getState()

  updateAgentThread(accountIndex, (thread) => ({
    exchanges: patchInFlight(thread.exchanges, { error: error.message, status: 'failed' }),
    isUnauthorized: isUnauthorized || thread.isUnauthorized,
  }))
}

const handleUpdateAccountTx = (data: WsUpdateExecutedTransactionMessage) =>
  data.txs.forEach((tx) => accountTxCallbacks.forEach((cb) => cb(tx)))

const handleSubscribedPoolInfo = (data: WsSubscribedPoolInfoMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)

  bufferedPoolInfo = {}
  useLighterStore.setState((prevState) => ({
    accounts: {
      ...prevState.accounts,
      [accountIndex]: {
        ...prevState.accounts[accountIndex],
        poolInfo: data.pool_info,
      },
    },
  }))

  ensureThrottledDataPush()
}

const handleUpdatePoolInfo = (data: WsUpdatePoolInfoMessage) => {
  const accountIndex = getAccountIndexFromChannel(data.channel)
  bufferedPoolInfo[accountIndex] = data.pool_info
}

const handleSubscribedHeight = (data: WsSubscribedHeightMessage) => {
  bufferedBlockHeight = data.height
  useLighterStore.setState({ height: data.height })
}

const handleUpdatedHeight = (data: WsUpdateHeightMessage) => {
  bufferedBlockHeight = data.height
}

const handleSubscribeNotification = (
  data: WsSubscribeNotificationMessage,
  triggerWsNotification: (data: WsNotificationType) => void,
) => {
  data.notifs.forEach((notif) => triggerWsNotification(notif))
}
const handleUpdateNotification = (
  data: WsUpdateNotificationMessage,
  triggerWsNotification: (notif: WsNotificationType) => void,
) => {
  data.notifs.forEach((notif) => triggerWsNotification(notif))
}

export const clearBufferedCandlesticksForKey = (key: string) => {
  delete bufferedNewCandlesticks[key]

  const { newCandlesticksByKey } = useLighterStore.getState()
  if (newCandlesticksByKey[key]) {
    const next = { ...newCandlesticksByKey }
    delete next[key]
    useLighterStore.setState({ newCandlesticksByKey: next })
  }
}

export const handleChangeDesiredMarket = (marketId: number) => {
  currentMarketId = marketId
  bufferedTrades = []
  bufferedLiquidationTrades = []
  bufferedOrderbook = { asks: [], bids: [] }

  useLighterStore.setState({
    trades: null,
    liquidationTrades: null,
    orderBook: null,
  })
}
