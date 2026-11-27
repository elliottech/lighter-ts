import type { TradesRequest } from 'zklighter-perps/apis/OrderApi'

import { apis } from '../lib/apis'
import { convertTrade } from './restApiConversion'

export type PageParam =
  | { cursor: string | undefined; skip_ask_order_id?: string; skip_bid_order_id?: string }
  | undefined

export const getTradesHistory = async (params: TradesRequest, pageParam?: PageParam) => {
  return apis.orderApi
    .trades({
      ...params,
      cursor: pageParam?.cursor,
      ...(params.aggregate
        ? {
            skip_ask_order_id: pageParam?.skip_ask_order_id,
            skip_bid_order_id: pageParam?.skip_bid_order_id,
          }
        : {}),
    })
    .then(({ trades, ...rest }) => ({
      ...rest,
      trades: trades.map(convertTrade),
    }))
}

export const getTradesHistoryNextPageParam = (
  lastPage: {
    next_cursor?: string
    trades: Array<{
      ask_account_id?: number | null
      ask_id_str?: string | null
      bid_account_id?: number | null
      bid_id_str?: string | null
    }>
  },
  pageSize: number,
  accountIndex: number,
): PageParam => {
  if (!lastPage.next_cursor) return undefined

  const lastTrade = lastPage.trades[pageSize - 1]
  return {
    cursor: lastPage.next_cursor,
    skip_ask_order_id:
      lastTrade?.ask_account_id === accountIndex ? (lastTrade?.ask_id_str ?? undefined) : undefined,
    skip_bid_order_id:
      lastTrade?.bid_account_id === accountIndex ? (lastTrade?.bid_id_str ?? undefined) : undefined,
  }
}
