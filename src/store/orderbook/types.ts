export interface ExtendedCandlestick {
  /** Candlestick time.
   * Amount of **milliseconds** since Unix epoch start in **UTC** timezone.
   * `time` for daily, weekly, and monthly candlesticks is expected to be a trading day (not session start day) at 00:00 UTC.
   * TradingView adjusts bar time according to `LibrarySymbolInfo.session`.
   */
  time: number
  /** Opening price */
  open: number
  /** High price */
  high: number
  /** Low price */
  low: number
  /** Closing price */
  close: number
  /** Trading volume (quote / volume1) */
  volume?: number
  /** Base trading volume (volume0) */
  volumeBase?: number

  lastTradeId: number
  marketId: number
  resolution: string
  isAggregated?: boolean
}
