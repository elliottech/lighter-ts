/**
 * Strategy or flow that placed an order, encoded in bits 45-47 of client_order_index.
 * 3 bits: values 5-7 are reserved for future kinds.
 */
export const StrategyOrderKind = {
  None: 0,
  AdvancedTwap: 1,
  ChaseLimit: 2,
  Iceberg: 3,
  Rfq: 4,
} as const
export type StrategyOrderKind = (typeof StrategyOrderKind)[keyof typeof StrategyOrderKind]
