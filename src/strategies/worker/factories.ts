import type {
  AdvancedTwapConfig,
  BaseResumeState,
  EngineEventListener,
  IcebergConfig,
  LimitChaseConfig,
  StrategyConfig,
  StrategyEngine,
  StrategyKind,
  TwapResumeState,
} from '../engine/types'

import { AdvancedTwapEngine, type EngineDeps } from '../engine/AdvancedTwapEngine'
import { IcebergEngine } from '../engine/IcebergEngine'
import { LimitChaseEngine } from '../engine/LimitChaseEngine'

export function createEngine(
  kind: StrategyKind,
  config: StrategyConfig,
  deps: EngineDeps,
  listener: EngineEventListener,
  resume?: BaseResumeState,
): StrategyEngine {
  switch (kind) {
    case 'advanced-twap':
      return new AdvancedTwapEngine(
        config as AdvancedTwapConfig,
        deps,
        listener,
        resume as TwapResumeState,
      )
    case 'chase-limit':
      return new LimitChaseEngine(config as LimitChaseConfig, deps, listener, resume)
    case 'iceberg':
      return new IcebergEngine(config as IcebergConfig, deps, listener, resume)
    default:
      throw new Error(`Unknown strategy kind: ${kind as string}`)
  }
}
