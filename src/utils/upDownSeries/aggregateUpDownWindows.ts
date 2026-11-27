import type { UpDownPriceCandle } from '../../ws-sub-store/upDownPrice'

/**
 * One candle per event window of `durationSeconds`, aligned to `fromSeconds`. A window closes at
 * the next window's open, the observation both of them resolve against. `boundaryPrices` (by
 * unix second) pins the resolved prices of settled windows, which a coarse candle can miss.
 */
export const aggregateUpDownWindows = (
  candles: UpDownPriceCandle[],
  fromSeconds: number,
  durationSeconds: number,
  boundaryPrices: ReadonlyMap<number, number> = new Map(),
): UpDownPriceCandle[] => {
  const windows: UpDownPriceCandle[] = []
  for (const candle of candles) {
    if (candle.timestamp < fromSeconds) continue
    const timestamp =
      fromSeconds + Math.floor((candle.timestamp - fromSeconds) / durationSeconds) * durationSeconds
    const last = windows.at(-1)
    if (last === undefined || last.timestamp !== timestamp) {
      windows.push({ ...candle, timestamp })
      continue
    }
    last.high = Math.max(last.high, candle.high)
    last.low = Math.min(last.low, candle.low)
    last.close = candle.close
  }
  for (const window of windows) {
    const open = boundaryPrices.get(window.timestamp)
    if (open === undefined) continue
    window.open = open
    window.high = Math.max(window.high, open)
    window.low = Math.min(window.low, open)
  }
  windows.forEach((window, index) => {
    const end = window.timestamp + durationSeconds
    const next = windows[index + 1]
    const close = boundaryPrices.get(end) ?? (next?.timestamp === end ? next.open : undefined)
    if (close === undefined) return
    window.close = close
    window.high = Math.max(window.high, close)
    window.low = Math.min(window.low, close)
  })
  return windows
}

/** Candles of several spans in ascending order, one per second where the spans overlap. */
export const mergeUpDownCandles = (lists: readonly UpDownPriceCandle[][]): UpDownPriceCandle[] => {
  const bySecond = new Map<number, UpDownPriceCandle>()
  for (const list of lists) for (const candle of list) bySecond.set(candle.timestamp, candle)
  return [...bySecond.values()].sort((a, b) => a.timestamp - b.timestamp)
}
