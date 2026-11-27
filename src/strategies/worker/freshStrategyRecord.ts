import type { StrategyRecord } from '../engine/types'
import type { MainToWorker } from './protocol'

/** The record of a strategy starting from nothing, as the frontends build it. */
export const freshStrategyRecord = ({
  id,
  strategyKind,
  config,
  createdAt,
}: Extract<MainToWorker, { kind: 'start' }>): StrategyRecord => ({
  id,
  kind: strategyKind,
  config,
  createdAt,
  progress: {
    status: 'running',
    totalBaseAmount: config.totalSize,
    filledBaseAmount: 0,
    filledQuoteAmount: 0,
    makerBaseAmount: 0,
    ...(strategyKind === 'advanced-twap' ? { failedBaseAmount: 0, consumedSlices: 0 } : {}),
    nextActionAt: null,
  },
  workingOrders: {},
})
