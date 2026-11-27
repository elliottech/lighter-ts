import { getCalendarCandleBucketTimeMs } from './getCalendarCandleBucketTimeMs'
import { fetchCandlePage } from './candleRecovery/fetchCandlePage'
import type { Candle, MarkPriceCandle } from 'zklighter-perps'
import type {
  CandlesResolutionEnum,
  MarkPriceCandlesResolutionEnum,
} from 'zklighter-perps/apis/CandlestickApi'

import type { ExtendedCandlestick } from '../store/orderbook/types'
import { apis } from '../lib/apis'

const LIGHTER_INITIAL_TIMESTAMP = 1735689600000
const BE_TIMESTAMP_MIN = 10000000000

export const getCandleKey = (marketId: number, resolution: string) => `${marketId}/${resolution}`

export const candleToCandlestick = (
  candle: Candle,
  marketId: number,
  resolution: string,
  showRawPrices: boolean,
): ExtendedCandlestick => {
  const openRaw = candle.O || candle.o
  const closeRaw = candle.C || candle.c
  const highRaw = candle.H || candle.h
  const lowRaw = candle.L || candle.l

  return {
    time: candle.t,
    open: showRawPrices ? openRaw : candle.o,
    close: showRawPrices ? closeRaw : candle.c,
    high: showRawPrices ? highRaw : candle.h,
    low: showRawPrices ? lowRaw : candle.l,
    volume: candle.V,
    volumeBase: candle.v,
    lastTradeId: candle.i,
    marketId,
    resolution,
  }
}

export const markPriceCandleToCandlestick = (
  candle: MarkPriceCandle,
  marketId: number,
  resolution: string,
): ExtendedCandlestick => ({
  time: candle.t,
  open: candle.o,
  high: candle.h,
  low: candle.l,
  close: candle.c,
  volume: 0,
  volumeBase: 0,
  lastTradeId: 0,
  marketId: marketId,
  resolution: resolution,
})

const isTradablePrice = (price: number | undefined): price is number =>
  price !== undefined && Number.isFinite(price) && price > 0

export const withContinuousOpen = (
  bar: ExtendedCandlestick,
  previousBar: Pick<ExtendedCandlestick, 'time' | 'open' | 'close'> | undefined,
): ExtendedCandlestick => {
  if (!previousBar) {
    return bar
  }
  const open = previousBar.time === bar.time ? previousBar.open : previousBar.close
  if (bar.open === open) {
    return bar
  }
  return {
    ...bar,
    open,
    high: Math.max(bar.high, open),
    low: Math.min(bar.low, open),
  }
}

const withContinuousOpens = (bars: ExtendedCandlestick[]): ExtendedCandlestick[] =>
  bars.map((bar, index) => {
    const prevClose = bars[index - 1]?.close
    if (prevClose === undefined || bar.open === prevClose) {
      return bar
    }
    return {
      ...bar,
      open: prevClose,
      high: Math.max(bar.high, prevClose),
      low: Math.min(bar.low, prevClose),
    }
  })

const isEmptyTradeCandle = (candle: Candle): boolean => !candle.v && !candle.V

export const mergeTradeAndMarkPriceCandles = (
  tradeCandles: Candle[],
  markPriceCandles: MarkPriceCandle[],
  marketId: number,
  resolution: string,
): ExtendedCandlestick[] => {
  const tradeByTime = new Map(tradeCandles.map((candle) => [candle.t, candle]))
  const markByTime = new Map(markPriceCandles.map((candle) => [candle.t, candle]))
  const times = Array.from(new Set([...tradeByTime.keys(), ...markByTime.keys()])).sort(
    (a, b) => a - b,
  )

  const bars: ExtendedCandlestick[] = []
  times.forEach((time) => {
    const tradeCandle = tradeByTime.get(time)
    const markCandle = markByTime.get(time)
    if (tradeCandle && !isEmptyTradeCandle(tradeCandle)) {
      bars.push(candleToCandlestick(tradeCandle, marketId, resolution, false))
      return
    }
    if (markCandle) {
      bars.push(markPriceCandleToCandlestick(markCandle, marketId, resolution))
      return
    }
    if (tradeCandle) {
      bars.push(candleToCandlestick(tradeCandle, marketId, resolution, false))
    }
  })

  return bars
}

export const markPriceCandlesWithTradeVolume = (
  markPriceCandles: MarkPriceCandle[],
  tradeCandles: Candle[],
  marketId: number,
  resolution: string,
): ExtendedCandlestick[] => {
  const tradeByTime = new Map(tradeCandles.map((candle) => [candle.t, candle]))
  return markPriceCandles.map((candle) => ({
    ...markPriceCandleToCandlestick(candle, marketId, resolution),
    volume: tradeByTime.get(candle.t)?.V ?? 0,
    volumeBase: tradeByTime.get(candle.t)?.v ?? 0,
  }))
}

const MS_IN_MINUTE = 60 * 1000
const MS_IN_HOUR = 60 * MS_IN_MINUTE
const MS_IN_DAY = 24 * MS_IN_HOUR

export const tvResToResInMiliseconds = (resolution: string): number => {
  switch (resolution) {
    case '1':
      return MS_IN_MINUTE
    case '3':
      return 3 * MS_IN_MINUTE
    case '5':
      return 5 * MS_IN_MINUTE
    case '15':
      return 15 * MS_IN_MINUTE
    case '30':
      return 30 * MS_IN_MINUTE
    case '60':
      return MS_IN_HOUR
    case '120':
      return 2 * MS_IN_HOUR
    case '240':
      return 4 * MS_IN_HOUR
    case '480':
      return 8 * MS_IN_HOUR
    case '720':
      return 12 * MS_IN_HOUR
    case '1D':
      return MS_IN_DAY
    case '3D':
      return 3 * MS_IN_DAY
    case '1W':
      return 7 * MS_IN_DAY
    case '1M':
      return 30 * MS_IN_DAY
    default:
      return 0
  }
}

export const obResToResInMiliseconds = (resolution: string): number => {
  switch (resolution) {
    case '1m':
      return MS_IN_MINUTE
    case '5m':
      return 5 * MS_IN_MINUTE
    case '15m':
      return 15 * MS_IN_MINUTE
    case '30m':
      return 30 * MS_IN_MINUTE
    case '1h':
      return MS_IN_HOUR
    case '4h':
      return 4 * MS_IN_HOUR
    case '12h':
      return 12 * MS_IN_HOUR
    case '1d':
      return MS_IN_DAY
    default:
      return 0
  }
}

export const tvResToObRes = (resolution: string) => {
  switch (resolution) {
    case '1':
    case '3':
      return '1m'
    case '5':
      return '5m'
    case '15':
      return '15m'
    case '30':
      return '30m'
    case '60':
    case '120':
      return '1h'
    case '240':
    case '480':
      return '4h'
    case '720':
      return '12h'
    case '1D':
    case '3D':
    case '1W':
    case '1M':
      return '1d'
    default:
      return '' as never
  }
}

export const withMidPriceClose = (
  bar: ExtendedCandlestick,
  midPrice: number | undefined,
): ExtendedCandlestick => {
  if (!isTradablePrice(midPrice) || bar.close === midPrice) {
    return bar
  }
  return {
    ...bar,
    close: midPrice,
    high: Math.max(bar.high, midPrice),
    low: Math.min(bar.low, midPrice),
  }
}

export const withPreviousRange = (
  bar: ExtendedCandlestick,
  previousBar: ExtendedCandlestick | undefined,
): ExtendedCandlestick => {
  if (!previousBar || previousBar.time !== bar.time) {
    return bar
  }
  const high = Math.max(bar.high, previousBar.high)
  const low = Math.min(bar.low, previousBar.low)
  return high === bar.high && low === bar.low ? bar : { ...bar, high, low }
}

export const withMidPriceOnLiveCandlestick = (
  bars: ExtendedCandlestick[],
  midPrice: number | undefined,
  now = Date.now(),
): ExtendedCandlestick[] => {
  const lastBar = bars[bars.length - 1]
  if (!lastBar || !isTradablePrice(midPrice)) {
    return bars
  }
  const resolutionMs = obResToResInMiliseconds(lastBar.resolution)
  if (now < lastBar.time || now >= lastBar.time + resolutionMs) {
    return bars
  }
  const liveBar = withMidPriceClose(lastBar, midPrice)
  return liveBar === lastBar ? bars : [...bars.slice(0, -1), liveBar]
}

export const nextLiveCandlestick = (
  lastBar: ExtendedCandlestick,
  midPrice: number | undefined,
  now = Date.now(),
): ExtendedCandlestick | null => {
  if (!isTradablePrice(midPrice)) {
    return null
  }
  const resolutionMs = obResToResInMiliseconds(lastBar.resolution)
  if (!resolutionMs || now < lastBar.time) {
    return null
  }
  if (now < lastBar.time + resolutionMs) {
    const liveBar = withMidPriceClose(lastBar, midPrice)
    return liveBar === lastBar ? null : liveBar
  }
  return {
    time: lastBar.time + Math.floor((now - lastBar.time) / resolutionMs) * resolutionMs,
    open: midPrice,
    high: midPrice,
    low: midPrice,
    close: midPrice,
    volume: 0,
    volumeBase: 0,
    lastTradeId: lastBar.lastTradeId,
    marketId: lastBar.marketId,
    resolution: lastBar.resolution,
  }
}

type CandlePage = {
  start_timestamp: number
  end_timestamp: number
  count_back: number
}

const getHistoricalCandlesPaginated = async <T extends { t: number }>(
  {
    from,
    to,
    countBack,
    strict,
    signal,
  }: {
    from: number
    to: number
    countBack: number
    strict?: boolean
    signal?: AbortSignal
  },
  fetchPage: (page: CandlePage, signal?: AbortSignal) => Promise<T[]>,
): Promise<T[]> => {
  if (from <= BE_TIMESTAMP_MIN || to <= LIGHTER_INITIAL_TIMESTAMP) {
    return []
  }
  const allCandles: T[] = []
  let currentTo = to
  let remainingCountBack = countBack

  while (remainingCountBack > 0) {
    try {
      const limit = Math.min(500, remainingCountBack)

      if (currentTo <= from) {
        break
      }

      // A future end shifts the edge's 500-bucket window past now, and the
      // backend pads the short window with a stored row from across a gap.
      const page = {
        start_timestamp: from,
        end_timestamp: Math.min(currentTo, Date.now()),
        count_back: limit,
      }
      const candles = strict
        ? await fetchCandlePage(signal, (pageSignal) => fetchPage(page, pageSignal))
        : await fetchPage(page, signal)

      if (!candles.length) {
        break
      }

      allCandles.unshift(...candles)
      remainingCountBack -= candles.length
      // Both REST endpoints include end_timestamp. Move strictly before the
      // oldest returned candle so overlapping pages do not consume countBack.
      currentTo = candles[0]!.t - 1

      if (candles.length < limit) {
        break
      }
    } catch (error) {
      if (strict) throw error
      break
    }
  }

  return allCandles
}

const getHistoricalCandles = ({
  marketId,
  resolution,
  from,
  to,
  countBack,
  strict,
  signal,
  mergeMarkPrice = false,
}: {
  marketId: number
  resolution: string
  from: number
  to: number
  countBack: number
  strict?: boolean
  signal?: AbortSignal
  mergeMarkPrice?: boolean
}) =>
  getHistoricalCandlesPaginated<Candle>(
    { from, to, countBack, strict, signal },
    async ({ start_timestamp, end_timestamp, count_back }, pageSignal) => {
      const { c, code, message } = await apis.candlesticksApi.candles(
        {
          market_id: marketId,
          resolution: resolution as CandlesResolutionEnum,
          start_timestamp,
          end_timestamp,
          count_back,
          ...(mergeMarkPrice ? { merge_mark_price: true } : {}),
        },
        { signal: pageSignal },
      )
      if (strict && code !== 200) throw new Error(message || 'Candle history failed')
      return c
    },
  )

const getHistoricalMarkPriceCandles = ({
  marketId,
  resolution,
  from,
  to,
  countBack,
  strict,
  signal,
}: {
  marketId: number
  resolution: string
  from: number
  to: number
  countBack: number
  strict?: boolean
  signal?: AbortSignal
}) =>
  getHistoricalCandlesPaginated<MarkPriceCandle>(
    { from, to, countBack, strict, signal },
    async ({ start_timestamp, end_timestamp, count_back }, pageSignal) => {
      const { c, code, message } = await apis.candlesticksApi.markPriceCandles(
        {
          market_id: marketId,
          resolution: resolution as MarkPriceCandlesResolutionEnum,
          start_timestamp,
          end_timestamp,
          count_back,
          connect_opens: true,
        },
        { signal: pageSignal },
      )
      if (strict && code !== 200) throw new Error(message || 'Candle history failed')
      return c
    },
  )

// Own both paginators even when a strict caller has no retry manager. A failed
// source must cancel its sibling before another history attempt can start.
const fetchCandleSources = async <T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    return await run(controller.signal)
  } finally {
    controller.abort()
    signal?.removeEventListener('abort', abort)
  }
}

const fetchHistoricalSourceCandlesticks = async ({
  period,
  marketId,
  resolution,
  showRawPrices,
  showMarkPriceCandles = false,
  strict = false,
  signal,
}: {
  period: { to: number; from: number; countBack: number }
  marketId: number
  resolution: string
  showRawPrices: boolean
  showMarkPriceCandles?: boolean
  strict?: boolean
  signal?: AbortSignal
}) => {
  const from = period.from * 1000
  const to = period.to * 1000
  const now = Date.now()
  const displayResolutionMs = tvResToResInMiliseconds(resolution)
  resolution = tvResToObRes(resolution)
  const resolutionMs = obResToResInMiliseconds(resolution)
  // countBack arrives in display bars while the fetches count backend bars,
  // which are finer on aggregated resolutions (3, 120, 480, 3D, 1W, 1M);
  // sizing by the window span instead of a per-bar ratio keeps variable-length
  // display bars (calendar months) from undershooting the window
  const countBack =
    resolutionMs > 0 && displayResolutionMs > resolutionMs
      ? Math.ceil((to - from) / resolutionMs)
      : period.countBack

  if (showMarkPriceCandles) {
    const [markPriceCandles, tradeCandles] = await fetchCandleSources(signal, (signal) =>
      Promise.all([
        getHistoricalMarkPriceCandles({
          marketId,
          resolution,
          from,
          to,
          countBack,
          strict,
          signal,
        }),
        getHistoricalCandles({
          marketId,
          resolution,
          from,
          to,
          countBack,
          strict,
          signal,
        }),
      ]),
    )

    return withContinuousOpens(
      markPriceCandlesWithTradeVolume(markPriceCandles, tradeCandles, marketId, resolution).filter(
        (bar) => bar.time < now,
      ),
    )
  }

  if (showRawPrices) {
    const tradeCandles = await getHistoricalCandles({
      marketId,
      resolution,
      from,
      to,
      countBack,
      strict,
      signal,
    })

    return tradeCandles
      .filter((candle) => candle.t < now)
      .map((candle) => candleToCandlestick(candle, marketId, resolution, true))
  }

  const mergedCandles = await getHistoricalCandles({
    marketId,
    resolution,
    from,
    to,
    countBack,
    strict,
    signal,
    mergeMarkPrice: true,
  })

  return withContinuousOpens(
    mergedCandles
      .filter((candle) => candle.t < now)
      .map((candle) => candleToCandlestick(candle, marketId, resolution, false)),
  )
}

/** A listing may start late, but a returned boundary must be aligned and contiguous. */
export const assertCompleteCandleBoundary = (
  bars: ReadonlyArray<{ time: number }>,
  start: number,
  end: number,
  sourceMs: number,
): void => {
  if (
    !bars.length ||
    bars.at(-1)!.time !== end ||
    bars.some(
      (bar, index) =>
        !Number.isFinite(bar.time) ||
        bar.time < start ||
        bar.time > end ||
        (bar.time - start) % sourceMs !== 0 ||
        (index > 0 && bar.time !== bars[index - 1]!.time + sourceMs),
    )
  )
    throw new Error('Incomplete candle history boundary')
}

/** Validate all source candles in the leading display bucket, including aligned Raw pages. */
export const assertCompleteLeadingCandleBucket = (
  bars: ReadonlyArray<{ time: number }>,
  resolution: string,
  sourceMs: number,
  toMs = bars.at(-1)?.time ?? 0,
): void => {
  const first = bars[0]
  if (!first) return
  const interval = tvResToResInMiliseconds(resolution)
  const start =
    resolution === '1M' || resolution === '1W' || resolution === '3D'
      ? getCalendarCandleBucketTimeMs(first.time, resolution)
      : Math.floor(first.time / interval) * interval
  const date = new Date(start)
  const next =
    resolution === '1M'
      ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
      : resolution === '3D'
        ? Math.min(start + interval, Date.UTC(date.getUTCFullYear() + 1, 0, 1))
        : start + interval
  // A live bucket and an explicitly truncated historical window may end early.
  const end = Math.min(
    next - sourceMs,
    Math.floor(Math.min(toMs, Date.now()) / sourceMs) * sourceMs,
  )
  assertCompleteCandleBoundary(
    bars.filter((bar) => bar.time < next),
    start,
    end,
    sourceMs,
  )
}

/** Complete the actual returned oldest bucket, since optimized REST pages can
 * start earlier than the requested window. Fetch its predecessor too so Default
 * and Mark opens agree with subsequent pages. Existing source callers opt in.
 */
export const fetchHistoricalCandlesticks = async (
  params: Parameters<typeof fetchHistoricalSourceCandlesticks>[0] & { completeBoundary?: boolean },
): Promise<ExtendedCandlestick[]> => {
  const source = await fetchHistoricalSourceCandlesticks(params)
  const duration = tvResToResInMiliseconds(params.resolution)
  const requestedStart =
    params.resolution === '1M' || params.resolution === '1W' || params.resolution === '3D'
      ? getCalendarCandleBucketTimeMs(params.period.from * 1000, params.resolution)
      : Math.floor((params.period.from * 1000) / duration) * duration
  // REST can prepend the last traded candle hours before a complete requested
  // window. It is not a source bucket owned by this page; do not try to repair
  // its unrelated gap. Keep the aligned requested bucket and validate it normally.
  const bars = params.completeBoundary
    ? source.filter((bar) => !Number.isFinite(bar.time) || bar.time >= requestedStart)
    : source
  const first = bars[0]
  if (!params.completeBoundary || !first || first.time <= LIGHTER_INITIAL_TIMESTAMP) return bars
  const resolution = params.resolution
  const interval = tvResToResInMiliseconds(resolution)
  const start =
    resolution === '1M' || resolution === '1W' || resolution === '3D'
      ? getCalendarCandleBucketTimeMs(first.time, resolution)
      : Math.floor(first.time / interval) * interval
  const sourceMs = obResToResInMiliseconds(tvResToObRes(resolution))
  const validate = (result: ExtendedCandlestick[]) => {
    assertCompleteLeadingCandleBucket(result, resolution, sourceMs, params.period.to * 1000)
    return result
  }
  if (first.time === start) return validate(bars)
  // Request through the first returned source bar. All later source candles
  // already belong to this page and must not be counted twice.
  const boundary = await fetchHistoricalSourceCandlesticks({
    ...params,
    resolution: sourceMs === MS_IN_DAY ? '1D' : String(sourceMs / MS_IN_MINUTE),
    period: {
      from: (start - sourceMs) / 1000,
      to: first.time / 1000,
      countBack: Math.floor((first.time - start) / sourceMs) + 2,
    },
  })
  const prefix = boundary.filter((bar) => bar.time >= start && bar.time <= first.time)
  assertCompleteCandleBoundary(prefix, start, first.time, sourceMs)
  return validate([...prefix, ...bars.slice(1)])
}
