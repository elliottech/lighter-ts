/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return */
import { marginPercentageToFraction } from '../../formulas/marginPercentageToFraction'
import { roundNumber } from '../../utils/precision'
import type { WsMessage } from '../types/WsMessage'

const transformOrderbookItem = (item: any) => {
  item.price = Number(item.price)
  item.size = Number(item.size)
}

const transformOrderbook = (orderbook: any) => {
  for (const row of orderbook.asks) transformOrderbookItem(row)
  for (const row of orderbook.bids) transformOrderbookItem(row)
}

const transformTrade = (trade: any) => {
  trade.size = Number(trade.size)
  trade.price = Number(trade.price)
  trade.usd_amount = Number(trade.usd_amount)
  trade.taker_fee = trade.taker_fee ?? 0
  trade.maker_fee = trade.maker_fee ?? 0
  trade.integrator_taker_fee = trade.integrator_taker_fee ?? 0
  trade.integrator_maker_fee = trade.integrator_maker_fee ?? 0
}

const transformTrades = (trades: any) => {
  for (const trade of trades) transformTrade(trade)
}

const transformCandle = (candle: any) => {
  candle.t = Number(candle.t)
  candle.o = Number(candle.o)
  candle.h = Number(candle.h)
  candle.l = Number(candle.l)
  candle.c = Number(candle.c)
  if (candle.O !== undefined && candle.O !== null) candle.O = Number(candle.O)
  if (candle.H !== undefined && candle.H !== null) candle.H = Number(candle.H)
  if (candle.L !== undefined && candle.L !== null) candle.L = Number(candle.L)
  if (candle.C !== undefined && candle.C !== null) candle.C = Number(candle.C)
  candle.v = Number(candle.v)
  candle.V = Number(candle.V)
  candle.i = Number(candle.i)
}

const transformCandles = (candles: any) => {
  for (const candle of candles) transformCandle(candle)
}

const transformMarkPriceCandle = (candle: any) => {
  candle.t = Number(candle.t)
  candle.o = Number(candle.o)
  candle.h = Number(candle.h)
  candle.l = Number(candle.l)
  candle.c = Number(candle.c)
  candle.sc = Number(candle.sc)
}

const transformMarkPriceCandles = (candles: any) => {
  for (const candle of candles) transformMarkPriceCandle(candle)
}

const transformOrder = (order: any) => {
  order.filled_base_amount = Number(order.filled_base_amount)
  order.filled_quote_amount = Number(order.filled_quote_amount)
  order.initial_base_amount = Number(order.initial_base_amount)
  order.remaining_base_amount = Number(order.remaining_base_amount)
  order.price = Number(order.price)
  order.trigger_price = Number(order.trigger_price)
}

const transformOrderArray = (orders: any) => {
  for (const order of orders) transformOrder(order)
}

const transformOrdersRecord = (orders: any) => {
  for (const key in orders) {
    transformOrderArray(orders[key])
  }
}

export const transformRfq = (rfq: any) => {
  rfq.base_amount = Number(rfq.base_amount)
  rfq.quote_amount = Number(rfq.quote_amount)
}

const transformRfqs = (rfqs: any) => {
  for (const rfq of rfqs) transformRfq(rfq)
}

const transformUpdatePosition = (position: any) => {
  position.initial_margin_fraction = marginPercentageToFraction(
    Number(position.initial_margin_fraction),
  )
  position.position = Number(position.position)
  position.avg_entry_price = Number(position.avg_entry_price)
  position.allocated_margin = Number(position.allocated_margin)
}

const transformPosition = (position: any) => {
  position.initial_margin_fraction = marginPercentageToFraction(
    Number(position.initial_margin_fraction),
  )
  position.position = Number(position.position)
  position.avg_entry_price = Number(position.avg_entry_price)
  position.allocated_margin = Number(position.allocated_margin)
  position.total_funding_paid_out = position.total_funding_paid_out
    ? Number(position.total_funding_paid_out)
    : 0
  position.total_discount = position.total_discount ? Number(position.total_discount) : 0
}

const transformPositionsRecord = (positions: any) => {
  for (const key in positions) {
    transformPosition(positions[key])
  }
}

const transformUpdatePositionsRecord = (positions: any) => {
  for (const key in positions) {
    transformUpdatePosition(positions[key])
  }
}

const transformAssetBalance = (assetBalance: any) => {
  assetBalance.balance = Number(assetBalance.balance)
  assetBalance.margin_balance = Number(assetBalance.margin_balance)
  assetBalance.locked_balance = Number(assetBalance.locked_balance)
  assetBalance.available_balance = Math.max(0, assetBalance.balance - assetBalance.locked_balance)
  assetBalance.available_margin_balance = Math.max(
    0,
    assetBalance.margin_balance -
      // this is to prevent locked_balance from affecting margin_balance for classic usdc when balance < locked_balance
      (assetBalance.margin_mode === 'disabled'
        ? 0
        : Math.max(0, assetBalance.locked_balance - assetBalance.balance)),
  )
}

const transformAssetBalancesRecord = (assets: any) => {
  for (const key in assets) {
    transformAssetBalance(assets[key])
  }
}

const transformSpotAvgEntryPrice = (entry: any) => {
  entry.avg_entry_price = Number(entry.avg_entry_price)
  entry.asset_size = Number(entry.asset_size)
}

const transformSpotAvgEntryPricesRecord = (avgEntryPrices: any) => {
  for (const key in avgEntryPrices) {
    transformSpotAvgEntryPrice(avgEntryPrices[key])
  }
}

const transformShare = (share: any) => {
  share.principal_amount = Number(share.principal_amount)
  share.entry_timestamp = share.entry_timestamp ?? 0
}

const transformShares = (shares: any) => {
  for (const share of shares) transformShare(share)
}

const transformPerpsMarketStats = (stats: any) => {
  stats.daily_quote_token_volume = roundNumber(stats.daily_quote_token_volume, 2)
  stats.daily_price_change = roundNumber(stats.daily_price_change / 100, 4)
  stats.last_trade_price = Number(stats.last_trade_price)
  stats.current_funding_rate = Number(stats.current_funding_rate)
  stats.index_price = Number(stats.index_price)
  stats.mark_price = Number(stats.mark_price)
  stats.mid_price = Number(stats.mid_price)
  stats.best_bid_price = Number(stats.best_bid_price)
  stats.best_ask_price = Number(stats.best_ask_price)
  stats.open_interest = Number(stats.open_interest)
  stats.open_interest_limit = Number(stats.open_interest_limit)
  stats.funding_clamp_big = Number(stats.funding_clamp_big)
  stats.funding_clamp_small = Number(stats.funding_clamp_small)
}

const transformPerpsMarketStatsMessage = (data: any) => {
  if (data.timestamp) data.timestamp = Number(data.timestamp)
  for (const key in data.market_stats) {
    transformPerpsMarketStats(data.market_stats[key])
  }
}

const transformSpotMarketStats = (stats: any) => {
  stats.daily_quote_token_volume = roundNumber(stats.daily_quote_token_volume, 2)
  stats.daily_price_change = roundNumber(stats.daily_price_change / 100, 4)
  stats.last_trade_price = Number(stats.last_trade_price)
  stats.index_price = Number(stats.index_price)
  stats.mid_price = Number(stats.mid_price)
  stats.best_bid_price = Number(stats.best_bid_price)
  stats.best_ask_price = Number(stats.best_ask_price)
}

const transformSpotMarketStatsMessage = (data: any) => {
  if (data.timestamp) data.timestamp = Number(data.timestamp)
  for (const key in data.spot_market_stats) {
    transformSpotMarketStats(data.spot_market_stats[key])
  }
}

const transformAssetStats = (stats: any) => {
  stats.index_price = Number(stats.index_price)
  stats.total_supplied = Number(stats.total_supplied)
}

const transformAssetStatsMessage = (data: any) => {
  for (const key in data.asset_stats) {
    transformAssetStats(data.asset_stats[key])
  }
}

const transformPoolInfo = (info: any) => {
  info.operator_fee = Number(info.operator_fee)
  info.min_operator_share_rate = Number(info.min_operator_share_rate)
}

const transformLastFundingRound = (lastFundingRound: any) => {
  for (const key in lastFundingRound) {
    lastFundingRound[key] = Number(lastFundingRound[key])
  }
}

const transformLastFundingDiscount = (lastFundingDiscount: any) => {
  for (const key in lastFundingDiscount) {
    lastFundingDiscount[key] = Number(lastFundingDiscount[key])
  }
}

const transformNotification = (notif: any) => {
  if (notif.kind === 'announcement') return
  notif.content.size = Number(notif.content.size)
  notif.content.usdc_amount = Number(notif.content.usdc_amount)
}

const transformNotifications = (notifs: any) => {
  for (const notif of notifs) transformNotification(notif)
}

const transformTradesRecord = (trades: any) => {
  for (const key in trades) {
    transformTrades(trades[key])
  }
}

const transformTradeMessage = (data: any) => {
  if (data.trades) transformTrades(data.trades)
  if (data.liquidation_trades) transformTrades(data.liquidation_trades)
}

const transformCandleMessage = (data: any) => {
  if (data.timestamp) data.timestamp = Number(data.timestamp)
  if (data.candles) transformCandles(data.candles)
}

const transformMarkPriceCandleMessage = (data: any) => {
  if (data.timestamp) data.timestamp = Number(data.timestamp)
  if (data.candles) transformMarkPriceCandles(data.candles)
}

const transformSubscribedAccountTradesMessage = (data: any) => {
  data.weekly_volume ??= 0
  data.daily_volume ??= 0
  if (data.trades) {
    transformTradesRecord(data.trades)
  }
}

const transformSubscribedPositionsMessage = (data: any) => {
  transformPositionsRecord(data.positions)
  transformShares(data.shares)
}

const transformUpdatePositionsMessage = (data: any) => {
  transformUpdatePositionsRecord(data.positions)
  if (data.last_funding_round) {
    transformLastFundingRound(data.last_funding_round)
  }
  if (data.last_funding_discount) {
    transformLastFundingDiscount(data.last_funding_discount)
  }
  transformShares(data.shares)
}

const transformOrderbookMessage = (data: any) => {
  transformOrderbook(data.order_book)
}

const transformUpdateAccountTradesMessage = (data: any) => {
  transformTradesRecord(data.trades)
}

const transformOrdersMessage = (data: any) => {
  transformOrdersRecord(data.orders)
}

const transformAssetsMessage = (data: any) => {
  transformAssetBalancesRecord(data.assets)
}

const transformSpotAvgEntryPricesMessage = (data: any) => {
  transformSpotAvgEntryPricesRecord(data.avg_entry_prices)
}

const transformPoolInfoMessage = (data: any) => {
  transformPoolInfo(data.pool_info)
}

const transformNotificationMessage = (data: any) => {
  transformNotifications(data.notifs)
}

const transformLivePointsMessage = (data: any) => {
  if (data.total_live_points != null) {
    data.total_live_points = Number(data.total_live_points)
  }
}

const transformAgentMessage = (data: any) => {
  const transformQA = (qa: any) => {
    qa.timestamp = Number(qa.timestamp)
  }

  data.history.forEach(transformQA)

  if (data.pending !== undefined) {
    transformQA(data.pending)
  }
}

export const transformWsMessage = (data: any): WsMessage => {
  switch (data.type) {
    case 'subscribed/order_book':
    case 'update/order_book':
      transformOrderbookMessage(data)
      break
    case 'subscribed/trade_fe':
    case 'update/trade_fe':
      transformTradeMessage(data)
      break
    case 'subscribed/candle':
    case 'update/candle':
      transformCandleMessage(data)
      break
    case 'subscribed/mark_price_candle':
    case 'update/mark_price_candle':
      transformMarkPriceCandleMessage(data)
      break
    case 'subscribed/market_stats':
    case 'update/market_stats':
      transformPerpsMarketStatsMessage(data)
      break
    case 'subscribed/spot_market_stats':
    case 'update/spot_market_stats':
      transformSpotMarketStatsMessage(data)
      break
    case 'subscribed/asset_stats':
    case 'update/asset_stats':
      transformAssetStatsMessage(data)
      break
    case 'subscribed/account_all_trades':
      transformSubscribedAccountTradesMessage(data)
      break
    case 'update/account_all_trades':
      transformUpdateAccountTradesMessage(data)
      break
    case 'subscribed/account_all_positions_fe':
      transformSubscribedPositionsMessage(data)
      break
    case 'update/account_all_positions_fe':
      transformUpdatePositionsMessage(data)
      break
    case 'subscribed/account_all_orders':
    case 'update/account_all_orders':
      transformOrdersMessage(data)
      break
    case 'subscribed/rfq':
    case 'update/rfq':
      transformRfqs(data.rfqs)
      break
    case 'subscribed/account_all_assets':
    case 'update/account_all_assets':
      transformAssetsMessage(data)
      break
    case 'subscribed/account_spot_avg_entry_prices':
    case 'update/account_spot_avg_entry_prices':
      transformSpotAvgEntryPricesMessage(data)
      break
    case 'subscribed/pool_info':
    case 'update/pool_info':
      transformPoolInfoMessage(data)
      break
    case 'subscribed/notification':
    case 'update/notification':
      transformNotificationMessage(data)
      break
    case 'subscribed/live_points':
    case 'update/live_points':
      transformLivePointsMessage(data)
      break
    case 'subscribed/agent':
      transformAgentMessage(data)
      break
  }

  return data
}
