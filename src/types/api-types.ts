export interface TxEventInfo {
  i: string // Order Index
  m: number // Market Index
  t?: { s: number } // Trade, Size
  to?: { i: string } // Taker Order, Index
  no?: { i: string } // New Order, Index
  ae?: string // App Error
  code?: number // App Error Code
  message?: string // App Error Message
}

export interface MarketOrderTxEventInfo {
  m: number // Market Index
  t: TradeInfo
  mo: OrderInfo // Maker Order
  to: OrderInfo // Taker Order
  ae: string // Api Error
}

export interface TradeInfo {
  p: number // Price
  s: number // Size
  tf: number // Taker Fee
  mf: number // Maker Fee
}

export interface OrderInfo {
  i: string // Order Index
  u: string // Client Account Index
  a: number // Owner account id
  is: number // Initial base amount
  p: number // Price
  rs: number // Remaining base amount
  ia: number // Is Ask
  ot: number // Order Type
  f: number // Time in force
  ro: number // Reduce Only
  tp: number // Trigger Price
  e: number // Expiry
  st: number // Status
  ts: number // Trigger status
  t0: number // To Trigger Order Index 0
  t1: number // To Trigger Order Index 1
  c0: number // To Cancel Order Index 0
  ifci: number // Integrator Fee Collector Index
  itf: number // Integrator Taker Fee
  imf: number // Integrator Maker Fee
  of: number // Order Flags
}
