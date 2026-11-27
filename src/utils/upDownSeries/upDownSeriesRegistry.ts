import {
  type UpDownSeries,
  type UpDownSeriesWindow,
  createUpDownSeries,
} from './createUpDownSeries'

interface Entry {
  series: UpDownSeries
  refCount: number
  releaseTimer?: ReturnType<typeof setTimeout>
  releasedAt: number
}

// Index rows and the detail page share windows, so navigating between them keeps the data.
const RELEASE_DELAY_MS = 10_000
const COMPLETE_CACHE_SIZE = 32

const entries = new Map<string, Entry>()

const getUpDownSeriesKey = ({ symbol, duration, startAt, endAt }: UpDownSeriesWindow) =>
  `${symbol.toUpperCase()}:${duration}:${startAt}:${endAt}`

const evictCompleted = () => {
  const idle = [...entries].filter(
    ([, entry]) => entry.refCount === 0 && entry.series.getState().isComplete,
  )
  if (idle.length <= COMPLETE_CACHE_SIZE) return
  idle.sort(([, a], [, b]) => a.releasedAt - b.releasedAt)
  for (const [key, entry] of idle.slice(0, idle.length - COMPLETE_CACHE_SIZE)) {
    entry.series.dispose()
    entries.delete(key)
  }
}

export const peekUpDownSeries = (window: UpDownSeriesWindow): UpDownSeries | undefined =>
  entries.get(getUpDownSeriesKey(window))?.series

export const acquireUpDownSeries = (window: UpDownSeriesWindow) => {
  const key = getUpDownSeriesKey(window)
  let entry = entries.get(key)
  if (entry === undefined) {
    entry = { series: createUpDownSeries(window), refCount: 0, releasedAt: 0 }
    entries.set(key, entry)
  }
  const acquired = entry
  clearTimeout(acquired.releaseTimer)
  acquired.releaseTimer = undefined
  acquired.refCount++

  let released = false
  return {
    series: acquired.series,
    release: () => {
      if (released) return
      released = true
      acquired.refCount--
      if (acquired.refCount > 0) return
      acquired.releasedAt = Date.now()
      // A finished window is immutable and cheap to keep; a running one holds a socket channel.
      if (acquired.series.getState().isComplete) {
        evictCompleted()
        return
      }
      acquired.releaseTimer = setTimeout(() => {
        if (acquired.refCount > 0 || entries.get(key) !== acquired) return
        if (acquired.series.getState().isComplete) {
          evictCompleted()
          return
        }
        acquired.series.dispose()
        entries.delete(key)
      }, RELEASE_DELAY_MS)
    },
  }
}

/** Recovers every mounted window after the page was suspended (tab hidden, sleep, offline). */
export const refreshUpDownSeries = () => {
  for (const entry of entries.values()) if (entry.refCount > 0) entry.series.refresh()
}

/** Test-only: drops every cached window. */
export const resetUpDownSeriesRegistry = () => {
  for (const entry of entries.values()) {
    clearTimeout(entry.releaseTimer)
    entry.series.dispose()
  }
  entries.clear()
}
