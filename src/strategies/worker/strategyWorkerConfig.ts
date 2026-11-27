import type { Encoding, Env } from '../..'

export interface StrategyWorkerConfig {
  customServer: string | null
  encoding: Encoding
  env: Env
  restApiBase: string
  wsApiBase: string
  wsPingIntervalMs: number
  wsPongTimeoutMs: number
}
