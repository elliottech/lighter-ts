import { isTestingEnvironment } from '../../testing/isTestingEnvironment'

declare global {
  interface Window {
    getSelectorStats?: () => SelectorCallStats[]
    clearSelectorStats?: () => void
  }
}

export interface SelectorCallStats {
  name: string
  totalCalls: number
  totalTimeMs: number
  avgTimeMs: number
  maxTimeMs: number
}

const selectorCallStats = new Map<
  string,
  { totalCalls: number; totalTimeMs: number; maxTimeMs: number }
>()

export const createTracking = <Params extends unknown[], Ret>(
  name: string,
  func: (...args: Params) => Ret,
) => {
  if (!isTestingEnvironment()) {
    return func
  }

  return (...args: Params) => {
    const startTime = performance.now()
    const result = func(...args)
    const endTime = performance.now()
    const elapsedTime = endTime - startTime

    // Here you could also track totalTimeMs, avgTimeMs, maxTimeMs if needed
    const stats = selectorCallStats.get(name) ?? { totalCalls: 0, totalTimeMs: 0, maxTimeMs: 0 }
    stats.totalCalls += 1
    stats.totalTimeMs += elapsedTime
    stats.maxTimeMs = Math.max(stats.maxTimeMs, elapsedTime)
    selectorCallStats.set(name, stats)

    return result
  }
}

function getSelectorStats(): SelectorCallStats[] {
  return Array.from(selectorCallStats.entries())
    .map(([name, stats]) => {
      return {
        name,
        ...stats,
        avgTimeMs: stats.totalTimeMs / stats.totalCalls,
      }
    })
    .sort((a, b) => b.totalCalls - a.totalCalls)
}

function clearSelectorStats() {
  selectorCallStats.clear()
}

if (typeof window !== 'undefined') {
  window.getSelectorStats = getSelectorStats
  window.clearSelectorStats = clearSelectorStats
}
