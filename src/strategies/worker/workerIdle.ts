import { flushStrategyStoreWrites } from '../store/strategyStorage'

interface WorkerIdleGuard {
  /** Engines running or starts pending. */
  isBusy: () => boolean
  onIdle: () => void
}

let guard: WorkerIdleGuard | null = null
let inFlightTasks = 0
let idleReported = false
let checkHandle: ReturnType<typeof setTimeout> | null = null

export const configureWorkerIdle = (next: WorkerIdleGuard): void => {
  guard = next
  inFlightTasks = 0
  idleReported = false
  if (checkHandle !== null) clearTimeout(checkHandle)
  checkHandle = null
}

/** New work arrived; the next idle is reported again. */
export const markWorkerBusy = (): void => {
  idleReported = false
}

/**
 * Counts an order RPC or volume lookup as outstanding until it settles. The
 * promise is returned untouched so callers keep its result and rejection.
 */
export const trackWorkerTask = <T>(task: Promise<T>): Promise<T> => {
  markWorkerBusy()
  inFlightTasks++
  const settle = () => {
    inFlightTasks--
    scheduleWorkerIdleCheck()
  }
  task.then(settle, settle)
  return task
}

const isIdle = () => guard !== null && inFlightTasks === 0 && !guard.isBusy()

/**
 * Re-evaluates on a macrotask so the continuation that follows a settled task
 * (an engine crediting a fill, starting a cancel or a volume lookup) is
 * counted before the decision. Pending store writes are flushed first: the
 * main thread terminates the worker on `idle`.
 */
export const scheduleWorkerIdleCheck = (): void => {
  if (checkHandle !== null) return
  checkHandle = setTimeout(() => {
    checkHandle = null
    void checkWorkerIdle()
  }, 0)
}

const checkWorkerIdle = async (): Promise<void> => {
  if (!isIdle() || idleReported) return
  await flushStrategyStoreWrites()
  if (!isIdle() || idleReported) return
  idleReported = true
  guard?.onIdle()
}
