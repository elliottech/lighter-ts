import type { EngineEventListener, StrategyEngine } from '../engine/types'
import { useStrategyStore } from '../store/strategyStore'
import { captureWorkerException } from './captureWorkerException'
import { creditOrderTradeVolumesV2 } from './creditOrderTradeVolumesV2'
import type { WorkerToMain } from './protocol'
import { scheduleWorkerIdleCheck } from './workerIdle'

export const makeEventListener =
  (
    strategyId: string,
    getEngines: () => Map<string, StrategyEngine>,
    post: (message: WorkerToMain) => void,
  ): EngineEventListener =>
  (event) => {
    const store = useStrategyStore.getState()
    switch (event.type) {
      case 'progress':
        store.patchProgress(strategyId, event.progress)
        break
      case 'status':
        store.patchProgress(strategyId, {
          status: event.status,
          reason: event.reason,
        })
        if (event.status === 'completed' || event.status === 'aborted') {
          getEngines().delete(strategyId)
          scheduleWorkerIdleCheck()
        }
        // Main shows the end notification and tracks the outcome from it.
        post({
          kind: 'event',
          id: strategyId,
          event: {
            ...event,
            record: useStrategyStore.getState().strategies[strategyId],
          },
        })
        break
      case 'track':
        post({ kind: 'event', id: strategyId, event })
        break
      case 'updateWorkingOrder':
        store.setWorkingOrder(strategyId, event.order)
        break
      case 'removeWorkingOrder': {
        // Only a tracked (resting) or adopted unconfirmed order is credited
        // here; an order that was terminal on submit was credited by the
        // order client already.
        const record = store.strategies[strategyId]
        if (
          event.order.order_id in (record?.workingOrders ?? {}) ||
          record?.unconfirmedOrders?.[event.order.client_order_index]
        ) {
          creditOrderTradeVolumesV2(strategyId, event.order)
        }
        break
      }
      case 'sentry':
        captureWorkerException(event.error, { tags: event.tags })
        break
    }
    return
  }
