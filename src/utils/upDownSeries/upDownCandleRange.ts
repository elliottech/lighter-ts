import { UP_DOWN_RESOLUTION_SECONDS, type UpDownResolution } from '../../ws-sub-store/upDownPrice'

interface UpDownChartDomain {
  from: number
  to: number
  step: number
}

export const getUpDownChartDomain = (
  startAt: number,
  endAt: number,
  resolution: UpDownResolution,
): UpDownChartDomain => ({
  from: Math.floor(startAt / 1_000),
  to: Math.floor(endAt / 1_000),
  step: UP_DOWN_RESOLUTION_SECONDS[resolution],
})

export interface UpDownCandleRange {
  startAt: number
  endAt: number
  domain: UpDownChartDomain
}

const UP_DOWN_CANDLE_MS = 300_000

/**
 * The `count` candles of an event's series up to and including the event once it has started,
 * or up to the window before it while it is upcoming, five minutes each or one per window of a
 * shorter event.
 */
export const getUpDownCandleRange = (
  event: { start_at: number; end_at: number },
  started: boolean,
  count: number,
): UpDownCandleRange => {
  const candleMs = Math.min(UP_DOWN_CANDLE_MS, event.end_at - event.start_at)
  const endAt = started ? event.end_at : event.start_at
  const startAt = endAt - count * candleMs
  return {
    startAt,
    endAt,
    domain: { from: startAt / 1_000, to: (endAt - candleMs) / 1_000, step: candleMs / 1_000 },
  }
}

/** The range split into spans of `pageSize` candles, oldest first, newest ending with the range. */
export const getUpDownCandlePages = (range: UpDownCandleRange, pageSize: number) => {
  const pageMs = pageSize * range.domain.step * 1_000
  const count = Math.ceil((range.endAt - range.startAt) / pageMs)
  return Array.from({ length: count }, (_, index) => {
    const endAt = range.endAt - (count - 1 - index) * pageMs
    return { startAt: Math.max(range.startAt, endAt - pageMs), endAt }
  })
}
