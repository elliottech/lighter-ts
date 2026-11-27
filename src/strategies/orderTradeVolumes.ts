// V2 maker/taker volume tracking: recomputes a finished order's maker/taker
// split from the venue's REST trades endpoint instead of trusting the ws fill
// deltas. Main-thread only — the engines never import this.

import { type MarketMeta } from './engine/types'
import { type Order, type WsTrade, roundNumber, wait } from '..'
import { getTradesHistory } from '../utils'

/** The venue's trade indexer can lag the ws fill stream slightly, so while
 *  the summed volume is short of the order's ws-confirmed fill the fetch
 *  retries before settling for what is indexed. */
const INDEXER_RETRY_ATTEMPTS = 3
const INDEXER_RETRY_DELAY_MS = 2000

interface OrderTradeVolumes {
  makerBaseAmount: number
  takerBaseAmount: number
}

export const sumOrderTradeVolumes = (
  trades: WsTrade[],
  orderIsAsk: boolean,
  market: MarketMeta,
): OrderTradeVolumes => {
  let makerBaseAmount = 0
  let takerBaseAmount = 0
  for (const trade of trades) {
    if (trade.is_maker_ask === orderIsAsk) {
      makerBaseAmount = roundNumber(makerBaseAmount + trade.size, market.size_decimals)
    } else {
      takerBaseAmount = roundNumber(takerBaseAmount + trade.size, market.size_decimals)
    }
  }
  return { makerBaseAmount, takerBaseAmount }
}

const fetchOnce = async (
  accountIndex: number,
  order: Order,
  market: MarketMeta,
): Promise<OrderTradeVolumes> => {
  const result = await getTradesHistory({
    sort_by: 'timestamp',
    sort_dir: 'desc',
    limit: 1,
    account_index: accountIndex,
    market_id: order.market_index,
    order_index: Number(order.order_id),
    order_index_str: order.order_id,
    aggregate: true,
  })
  return sumOrderTradeVolumes(result.trades, order.is_ask, market)
}

export async function fetchOrderTradeVolumes(params: {
  accountIndex: number
  order: Order
  market: MarketMeta
}): Promise<OrderTradeVolumes> {
  const { accountIndex, order, market } = params
  for (let attempt = 1; ; attempt++) {
    // this endpoint takes a bit of time until it returns all the trades
    // first wait
    await wait(attempt * 2000)
    const volumes = await fetchOnce(accountIndex, order, market)
    const total = roundNumber(
      volumes.makerBaseAmount + volumes.takerBaseAmount,
      market.size_decimals,
    )
    if (total >= order.filled_base_amount || attempt >= INDEXER_RETRY_ATTEMPTS) {
      return volumes
    }
    // second wait
    await wait(INDEXER_RETRY_DELAY_MS)
  }
}
