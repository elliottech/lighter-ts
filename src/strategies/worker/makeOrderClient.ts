import {
  type CancelResult,
  ENGINE_ORDER_TYPE,
  type MarketDataSource,
  type ModifyResult,
  type OrderClient,
  type StrategyEngine,
  type SubmitResult,
} from '../engine/types'
import { type Order, isOrderActive, transactionConfig } from '../..'
import {
  UnconfirmedOrderError,
  UnpersistedOrderError,
  VOLUME_QUOTA_ABORT_THRESHOLD,
  VolumeQuotaExhaustedError,
  isVolumeQuotaError,
} from '../engine/errors'
import { assertOrderPriceNearIndex } from '../engine/planner'
import { captureWorkerException } from './captureWorkerException'
import { creditOrderTradeVolumesV2 } from './creditOrderTradeVolumesV2'
import { flushLatestStrategyStoreWrite } from '../store/strategyStorage'
import { trackWorkerTask } from './workerIdle'
import { useStrategyStore } from '../store/strategyStore'

import {
  cancelOrderUntilTerminalState,
  createOrderUntil,
  modifyOrderUntilApplied,
} from '../orderLifecycle'
import { getStrategyIntegratorFees } from './workerAccountFees'

let draining = false
const neverSettles = new Promise<never>(() => {})

/**
 * The worker is exiting: new submits and modifies never settle, so no engine
 * counts them as failed and the resumed strategy places them itself. Cancels
 * still go out.
 */
export const drainOrderClients = (): void => {
  draining = true
}

export function makeOrderClient(
  id: string,
  getEngines: () => Map<string, StrategyEngine>,
  marketData: MarketDataSource,
): OrderClient {
  const client = makeUntrackedOrderClient(id, getEngines, marketData)
  let volumeQuotaRejections = 0
  const countVolumeQuotaRejections = async <T>(call: Promise<T>): Promise<T> => {
    try {
      const result = await call
      volumeQuotaRejections = 0
      return result
    } catch (error) {
      volumeQuotaRejections = isVolumeQuotaError(error) ? volumeQuotaRejections + 1 : 0
      if (volumeQuotaRejections >= VOLUME_QUOTA_ABORT_THRESHOLD) {
        throw new VolumeQuotaExhaustedError()
      }
      throw error
    }
  }
  return {
    submitOrder: (input) =>
      draining
        ? neverSettles
        : trackWorkerTask(countVolumeQuotaRejections(client.submitOrder(input))),
    modifyOrder: (input) =>
      draining
        ? neverSettles
        : trackWorkerTask(countVolumeQuotaRejections(client.modifyOrder(input))),
    cancelOrder: (input) => trackWorkerTask(client.cancelOrder(input)),
  }
}

function makeUntrackedOrderClient(
  id: string,
  getEngines: () => Map<string, StrategyEngine>,
  marketData: MarketDataSource,
): OrderClient {
  /**
   * An order still resting after a submit or modify becomes the strategy's
   * working order, so the ws fill stream, ownership guard and cleanup all
   * point at it. One that is already terminal (market orders always, a limit
   * order that closed instantly) never does: its trades are final, so its V2
   * volumes are credited now — tracking it would let the ws watcher count it
   * a second time. A resting order whose engine has already ended is
   * cancelled instead; if that fails it is tracked so the abort cleanup still
   * finds it.
   */
  const adoptOrCancel = async (
    order: Order,
    accountIndex: number,
    marketId: number,
  ): Promise<Order> => {
    if (!isOrderActive(order)) {
      creditOrderTradeVolumesV2(id, order)
      return order
    }
    const status = getEngines().get(id)?.getProgress().status
    if (status === 'running') {
      useStrategyStore.getState().addWorkingOrder(id, order)
      return order
    }
    try {
      const canceledOrder = await cancelOrderUntilTerminalState({
        accountIndex,
        marketId,
        orderId: order.order_id,
        clientOrderIndex: order.client_order_index,
      })
      creditOrderTradeVolumesV2(id, canceledOrder)
      return canceledOrder
    } catch (error) {
      captureWorkerException(error, {
        tags: { feature: 'strategy-worker-cancel-after-end' },
      })
      useStrategyStore.getState().addWorkingOrder(id, order)
      return order
    }
  }

  return {
    submitOrder: async (input): Promise<SubmitResult> => {
      const isMarketOrder = input.orderType === ENGINE_ORDER_TYPE.market
      // Persisted and committed before the order is signed: a worker lost
      // between the submit and the ws confirmation would otherwise forget
      // the order, and a resumed strategy would place its size again.
      const clientOrderIndex = await transactionConfig.generateClientOrderIndex(
        input.strategyOrderKind,
      )
      useStrategyStore.getState().addUnconfirmedOrder(id, clientOrderIndex, {
        marketId: input.orderBookIndex,
        orderType: input.orderType,
        sentAt: Date.now(),
      })
      if (!(await flushLatestStrategyStoreWrite())) {
        useStrategyStore.getState().removeUnconfirmedOrder(id, clientOrderIndex)
        throw new UnpersistedOrderError('Failed to save the order before sending it')
      }
      let order: Order
      try {
        assertOrderPriceNearIndex(marketData, input.orderBookIndex, input.price, input.isAsk)
        order = await createOrderUntil(
          {
            ...input,
            clientOrderIndex,
            integratorFees: getStrategyIntegratorFees(),
          },
          (o) => !isMarketOrder || !isOrderActive(o),
        )
      } catch (error) {
        // An order that may have executed unseen stays on record; any other
        // failure means the tx can no longer execute.
        if (!(error instanceof UnconfirmedOrderError)) {
          useStrategyStore.getState().removeUnconfirmedOrder(id, clientOrderIndex)
        }
        throw error
      }
      return {
        order: await adoptOrCancel(order, input.accountIndex, input.orderBookIndex),
      }
    },
    modifyOrder: async ({ isAsk, ...input }): Promise<ModifyResult> => {
      assertOrderPriceNearIndex(marketData, input.marketId, input.price, isAsk)
      const order = await modifyOrderUntilApplied(input)
      return {
        order: await adoptOrCancel(order, input.accountIndex, input.marketId),
      }
    },
    cancelOrder: async (input): Promise<CancelResult> => {
      const order = await cancelOrderUntilTerminalState(input)
      return { order }
    },
  }
}
