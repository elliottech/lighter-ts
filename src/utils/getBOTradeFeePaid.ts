import type { WsTrade } from '../lighter-ws/types/WsMessage'
import { getFeePercentage } from './fees'

export const getBOTradeFeePaid = (
  trade: Pick<
    WsTrade,
    | 'is_maker_ask'
    | 'ask_account_id'
    | 'bid_account_id'
    | 'maker_fee'
    | 'integrator_maker_fee'
    | 'taker_fee'
    | 'integrator_taker_fee'
    | 'price'
    | 'size'
  >,
  accountIndex: number,
): number => {
  const isMaker =
    (trade.is_maker_ask ? trade.ask_account_id : trade.bid_account_id) === accountIndex
  const feeTick = isMaker
    ? (trade.maker_fee ?? 0) + (trade.integrator_maker_fee ?? 0)
    : (trade.taker_fee ?? 0) + (trade.integrator_taker_fee ?? 0)
  return trade.price * trade.size * getFeePercentage(feeTick)
}
