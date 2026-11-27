import { AccountAssetMarginModeEnum } from 'zklighter-perps'

import { MAX_MARKET_ORDER_SLIPPAGE } from '../constants/shared'
import { computeWorstExecutionPrice } from '../formulas/orderBook'
import { selectAssetBalances } from '../store/accounts/selectors'
import {
  USDC_ASSET_ID,
  selectSpotMarketsStats,
  selectSpotOrderBookMetasByBaseAssetId,
} from '../store/orderbook/selectors'
import type { LighterStore } from '../store/useLighterStore'
import type { CreateOrderParams } from '../types/order'
import { TxOrderTypes, TxTimeInForceTypes } from '../types/user'
import { convertFloatToBase } from './common'

const REPAY_DEBT_BID_SLIPPAGE = 1

type RepayDebtOrders = {
  orders: { type: 'create'; params: CreateOrderParams }[]
  skippedMarketIds: number[]
}

export const buildRepayDebtOrders = (
  state: LighterStore,
  {
    accountIndex,
    debt,
    isMarketDataLive,
  }: { accountIndex: number; debt: number; isMarketDataLive: boolean },
): RepayDebtOrders => {
  const orders: RepayDebtOrders['orders'] = []
  const skippedMarketIds: number[] = []

  if (!Number.isFinite(debt) || debt <= 0) {
    return { orders, skippedMarketIds }
  }

  const assetBalances = selectAssetBalances(state, { accountIndex })
  const marketsByAssetId = selectSpotOrderBookMetasByBaseAssetId(state)
  const marketsStats = selectSpotMarketsStats(state)
  let remainingDebt = debt

  for (const assetId in assetBalances) {
    const balance = assetBalances[assetId]

    if (
      !balance ||
      balance.margin_mode === AccountAssetMarginModeEnum.Disabled ||
      balance.asset_id === USDC_ASSET_ID ||
      !(balance.margin_balance > 0)
    ) {
      continue
    }

    const market = marketsByAssetId[balance.asset_id]
    if (!market) {
      continue
    }

    const availableBaseAmount = convertFloatToBase(balance.margin_balance, market.size_decimals)
    if (!(availableBaseAmount >= 1)) {
      continue
    }

    const stats = marketsStats[market.market_id]
    const bestBid = stats?.best_bid_price ?? 0
    const indexPrice = stats?.index_price ?? 0
    const sellPrice = Math.max(
      computeWorstExecutionPrice(REPAY_DEBT_BID_SLIPPAGE, true, bestBid),
      computeWorstExecutionPrice(MAX_MARKET_ORDER_SLIPPAGE, true, indexPrice),
    )
    const price = convertFloatToBase(sellPrice, market.price_decimals)

    if (!isMarketDataLive || !(bestBid > 0) || !(indexPrice > 0) || !(price >= 1)) {
      skippedMarketIds.push(market.market_id)
      continue
    }

    const requiredBaseAmount = remainingDebt / sellPrice

    orders.push({
      type: 'create',
      params: {
        accountIndex,
        orderBookIndex: market.market_id,
        baseAmount: Math.min(
          Math.max(1, convertFloatToBase(requiredBaseAmount, market.size_decimals)),
          availableBaseAmount,
        ),
        price,
        isAsk: 1,
        reduceOnly: 0,
        orderType: TxOrderTypes.OrderTypeMarket,
        timeInForce: TxTimeInForceTypes.OrderImmediateOrCancel,
        orderExpiry: 0,
        triggerPrice: 0,
      },
    })

    if (requiredBaseAmount > balance.margin_balance) {
      remainingDebt -= balance.margin_balance * sellPrice
    } else {
      break
    }
  }

  return { orders, skippedMarketIds }
}
