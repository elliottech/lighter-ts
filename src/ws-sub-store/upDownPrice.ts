export type UpDownResolution = '1s' | '30s'

export const UP_DOWN_RESOLUTION_SECONDS: Record<UpDownResolution, number> = {
  '1s': 1,
  '30s': 30,
}

// The websocket snapshot carries the newest 300 candles; keep the same depth for updates.
export const UP_DOWN_LIVE_CANDLE_LIMIT = 300

export const formatUpDownDuration = (duration: number): string => {
  if (duration % 3_600 === 0) return `${duration / 3_600}h`
  if (duration % 60 === 0) return `${duration / 60}m`
  return `${duration}s`
}

export const getUpDownCandleChannel = (
  symbol: string,
  duration: number,
  resolution: UpDownResolution,
): string =>
  `up_down_candle/${symbol.toLowerCase()}/${formatUpDownDuration(duration)}/${resolution}`

const UP_DOWN_DURATION_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600 }

const parseUpDownDuration = (label: string): number =>
  Number.parseInt(label, 10) * (UP_DOWN_DURATION_UNIT_SECONDS[label.slice(-1)] ?? 0)

export const getUpDownCandleKey = (
  symbol: string,
  duration: number,
  resolution: UpDownResolution,
): string => `${symbol.toUpperCase()}:${duration}:${resolution}`

// Server acks and updates spell the channel with ':' separators, subscriptions with '/'.
export const getUpDownCandleKeyFromChannel = (channel: string): string => {
  const [, symbol = '', duration = '', resolution = ''] = channel.split(/[/:]/)
  return getUpDownCandleKey(symbol, parseUpDownDuration(duration), resolution as UpDownResolution)
}

export interface UpDownPriceCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
}

/** Merges candles by bucket timestamp, keeping the newest `limit` in ascending order. */
export const upsertUpDownCandles = (
  candles: UpDownPriceCandle[],
  updates: UpDownPriceCandle[],
  limit = Number.POSITIVE_INFINITY,
): UpDownPriceCandle[] => {
  if (updates.length === 0) return candles
  const next = [...candles]
  for (const { timestamp, open, high, low, close } of [...updates].sort(
    (a, b) => a.timestamp - b.timestamp,
  )) {
    const candle = { timestamp, open, high, low, close }
    const last = next.at(-1)
    if (last === undefined || timestamp > last.timestamp) {
      next.push(candle)
      continue
    }
    let index = next.length - 1
    while (index > 0 && next[index]!.timestamp > timestamp) index--
    if (next[index]!.timestamp === timestamp) next[index] = candle
    else if (next[index]!.timestamp < timestamp) next.splice(index + 1, 0, candle)
    else next.splice(index, 0, candle)
  }
  return next.length > limit ? next.slice(-limit) : next
}

// Without an observation at a boundary second the backend falls back to the latest one shortly
// before it, once a later observation shows the boundary second was skipped.
const UP_DOWN_BOUNDARY_LOOKBACK_SECONDS = 10

/** The price the backend resolves at a window boundary, or null until it is known. */
export const getUpDownPriceAt = (
  candles: UpDownPriceCandle[],
  timestampMs: number,
): number | null => {
  const timestamp = Math.floor(timestampMs / 1_000)
  let previous: UpDownPriceCandle | undefined
  for (const candle of candles) {
    if (candle.timestamp === timestamp) return candle.open
    if (candle.timestamp > timestamp) {
      return previous !== undefined &&
        previous.timestamp >= timestamp - UP_DOWN_BOUNDARY_LOOKBACK_SECONDS
        ? previous.close
        : null
    }
    previous = candle
  }
  return null
}
