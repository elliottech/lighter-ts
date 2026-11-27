import type { MarketMeta } from '../engine/types'
import { type Order, type WsOrder, roundNumber, selectOrderBookMetas, useLighterStore } from '../..'
import { fetchOrderTradeVolumes } from '../orderTradeVolumes'
import { useStrategyStore } from '../store/strategyStore'
import { captureWorkerException } from './captureWorkerException'
import { trackWorkerTask } from './workerIdle'

/**
 * Credits a terminal order's REST maker/taker split to the strategy. The
 * order is dropped from the tracked working and unconfirmed orders in the
 * same pass, so the engine's later `removeWorkingOrder` cannot credit it a
 * second time.
 */
export function creditOrderTradeVolumesV2(strategyId: string, order: WsOrder): void {
  const store = useStrategyStore.getState()
  store.removeWorkingOrder(strategyId, order.order_id)
  store.removeUnconfirmedOrder(strategyId, order.client_order_index)
  if (order.filled_base_amount <= 0) return

  const record = useStrategyStore.getState().strategies[strategyId]
  if (!record) return
  const market = resolveMarket(record.config.marketId)
  if (!market) return

  void trackWorkerTask(
    fetchOrderTradeVolumes({
      accountIndex: record.config.accountIndex,
      order,
      market,
    })
      .then(({ makerBaseAmount, takerBaseAmount }) => {
        const current = useStrategyStore.getState().strategies[strategyId]
        if (!current) return
        useStrategyStore.getState().patchProgress(strategyId, {
          makerBaseAmountV2: roundNumber(
            (current.progress.makerBaseAmountV2 ?? 0) + makerBaseAmount,
            market.size_decimals,
          ),
          takerBaseAmountV2: roundNumber(
            (current.progress.takerBaseAmountV2 ?? 0) + takerBaseAmount,
            market.size_decimals,
          ),
        })
      })
      .catch((err) => {
        captureWorkerException(err, {
          id: strategyId,
          orderId: order.order_id,
          feature: 'strategy-volume-tracker-v2',
        })
      }),
  )
}

/**
 * Credits the fills a cancelled order picked up after its last persisted
 * snapshot, so the engine's final progress is not under-reported.
 */
export function creditClosingOrderFillDelta(
  strategyId: string,
  baseline: Order,
  latest: Order,
): void {
  creditFillDelta(strategyId, {
    baseDelta: latest.filled_base_amount - baseline.filled_base_amount,
    quoteDelta: latest.filled_quote_amount - baseline.filled_quote_amount,
    isMaker: true,
  })
}

/** Adds fills no engine credited to the strategy's persisted progress. */
export function creditFillDelta(
  strategyId: string,
  { baseDelta, quoteDelta, isMaker }: { baseDelta: number; quoteDelta: number; isMaker: boolean },
): void {
  if (baseDelta <= 0) return
  const store = useStrategyStore.getState()
  const record = store.strategies[strategyId]
  if (!record) return
  const market = resolveMarket(record.config.marketId)
  const roundBase = (value: number) => (market ? roundNumber(value, market.size_decimals) : value)
  const { filledBaseAmount, filledQuoteAmount, makerBaseAmount } = record.progress
  store.patchProgress(strategyId, {
    filledBaseAmount: roundBase(filledBaseAmount + baseDelta),
    filledQuoteAmount: filledQuoteAmount + quoteDelta,
    makerBaseAmount: isMaker ? roundBase(makerBaseAmount + baseDelta) : makerBaseAmount,
  })
}

const resolveMarket = (marketId: number): MarketMeta | undefined => {
  // MarketMeta is a structural subset of OrderBookDetail (Pick<>); the venue
  // detail returned by selectOrderBookMetas already satisfies it.
  const metas = selectOrderBookMetas(useLighterStore.getState())
  return metas[marketId]
}
