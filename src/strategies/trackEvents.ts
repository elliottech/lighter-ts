export const StrategyEngineTrackEvents = {
  STARTED: 'strategy.engine.started',
  COMPLETED: 'strategy.engine.completed',
  ABORTED: 'strategy.engine.aborted',
  SLICE_STARTED: 'strategy.engine.slice.started',
  SLICE_ENDED: 'strategy.engine.slice.ended',
  SLICE_FAILED: 'strategy.engine.slice.failed',
  SUBMIT_STARTED: 'strategy.engine.submit.started',
  SUBMIT_SUCCEEDED: 'strategy.engine.submit.succeeded',
  SUBMIT_FAILED: 'strategy.engine.submit.failed',
  MODIFY_STARTED: 'strategy.engine.modify.started',
  MODIFY_SUCCEEDED: 'strategy.engine.modify.succeeded',
  MODIFY_FAILED: 'strategy.engine.modify.failed',
  CANCEL_STARTED: 'strategy.engine.cancel.started',
  CANCEL_SUCCEEDED: 'strategy.engine.cancel.succeeded',
  CANCEL_FAILED: 'strategy.engine.cancel.failed',
} as const

export const StrategyManagerTrackEvents = {
  STOP_REQUESTED: 'strategy.manager.stop-requested',
  VOLUME_FETCH_FAILED: 'strategy.manager.volume-fetch-failed',
} as const

export type StrategyOrderOp = 'submit' | 'modify' | 'cancel'

export const ORDER_OP_TRACK_EVENTS: Record<
  StrategyOrderOp,
  { started: string; succeeded: string; failed: string }
> = {
  submit: {
    started: StrategyEngineTrackEvents.SUBMIT_STARTED,
    succeeded: StrategyEngineTrackEvents.SUBMIT_SUCCEEDED,
    failed: StrategyEngineTrackEvents.SUBMIT_FAILED,
  },
  modify: {
    started: StrategyEngineTrackEvents.MODIFY_STARTED,
    succeeded: StrategyEngineTrackEvents.MODIFY_SUCCEEDED,
    failed: StrategyEngineTrackEvents.MODIFY_FAILED,
  },
  cancel: {
    started: StrategyEngineTrackEvents.CANCEL_STARTED,
    succeeded: StrategyEngineTrackEvents.CANCEL_SUCCEEDED,
    failed: StrategyEngineTrackEvents.CANCEL_FAILED,
  },
}
