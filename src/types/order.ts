import type { TxOrderTypes, TxTimeInForceTypes } from './user'

export type OrderPlacementInput = 'base' | 'quote' | 'percentage'
export type SLTPInput = 'triggerPrice' | 'usd' | 'percent'
export const OrderType = {
  Market: 'market',
  Limit: 'limit',
  Conditional: 'conditional',
  Twap: 'twap',
  Scale: 'scale',
} as const
export type OrderType = (typeof OrderType)[keyof typeof OrderType]

// Fees are in millionths of notional (FeeTick = 1_000_000 <=> 100%, so 1 bp = 100)
export type IntegratorFees = {
  accountIndex: number
  takerFee: number
  makerFee: number
}

export type CreateOrderParams = {
  accountIndex: number
  orderBookIndex: number
  clientOrderIndex?: number
  baseAmount: number
  price: number
  isAsk: number
  orderType: TxOrderTypes
  timeInForce: TxTimeInForceTypes
  reduceOnly: number
  triggerPrice: number
  orderExpiry: number
  integratorFees?: IntegratorFees
}

export type TxResponse = { txInfo: string; txHash: string }

export type GroupedOrderParams = {
  accountIndex: number
  groupingType: number
  orders: CreateOrderParams[]
  // Applies to the group as a whole — the tx carries one set of integrator
  // attributes. Per-order integratorFees inside `orders` is not signed.
  integratorFees?: IntegratorFees
}

export type CancelOrderParams = {
  accountIndex: number
  marketId: number
  orderId: string
}

export type CancelAllOrdersParams = {
  accountIndex: number
  timeInForce: number
  time: number
  marketId?: number
}

export type ModifyOrderParams = {
  accountIndex: number
  marketId: number
  orderId: string
  baseAmount: number
  price: number
  triggerPrice: number
}

export type OrderParams =
  | { type: 'create'; params: CreateOrderParams }
  | { type: 'modify'; params: ModifyOrderParams }
  | { type: 'cancel'; params: CancelOrderParams }
