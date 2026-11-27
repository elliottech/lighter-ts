import type { Clock } from '../engine/types'
import type { StrategiesServerPlatform } from '../wsProtocol'
import type { MaintenanceSchedule } from './maintenanceSchedule'

export const SCHEDULE_POLL_INTERVAL_MS = 5 * 60_000
export const ANNOUNCED_SCHEDULE_POLL_INTERVAL_MS = 60_000
/** Polls switch to the announced interval once the start is this close. */
export const NEAR_SCHEDULE_MS = 3 * SCHEDULE_POLL_INTERVAL_MS
/** The worker is stopped this long before the announced start. */
export const PAUSE_LEAD_MS = 60_000
/**
 * A scheduled downtime is not probed before this long after the pause, and a
 * start that elapsed less than this long ago is in progress, maintenance page up or not.
 */
export const MIN_SCHEDULED_DOWNTIME_MS = 5 * 60_000
export const PROBE_INTERVAL_MS = 30_000
/** Consecutive successful probes before resuming. */
export const PROBE_SUCCESSES_TO_RESUME = 6
export const MAX_RESUME_JITTER_MS = 60_000
/** A failing schedule fetch is reported once, then once this often while it keeps failing. */
export const SCHEDULE_ERROR_REPORT_INTERVAL_MS = 60 * 60_000
export const STRATEGIES_WS_UPDATE_DOWNTIME_ERROR =
  'Lighter maintenance is in progress or less than 15 minutes away, update the strategies server once it is over'
/** Node fires a longer timeout immediately. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1

export interface PlatformMonitorOptions {
  clock: Clock
  /** In [0, 1), spreads the resumes of every server over a minute. */
  random: () => number
  fetchSchedule: () => Promise<MaintenanceSchedule>
  /** The backend's clock minus this machine's, in ms. */
  fetchServerTimeOffset: () => Promise<number>
  /** Resolves when the backend serves what a resume needs. */
  probe: () => Promise<void>
  /** Stops the worker without touching its strategies. */
  pause: () => Promise<void>
  /**
   * Starts a worker, which resumes the running strategies. Also called once
   * the first check finds no maintenance in progress, or locize does not answer.
   */
  resume: () => void
  onError: (error: unknown) => void
}

export interface PlatformMonitor {
  getPlatform: () => StrategiesServerPlatform
  subscribePlatform: (listener: (platform: StrategiesServerPlatform) => void) => () => void
  isPaused: () => boolean
  /**
   * Up, or the announced start is more than NEAR_SCHEDULE_MS away: a version
   * started now gets ready before the pause, so the launcher keeps it.
   */
  allowsUpdate: () => boolean
  close: () => void
}

/**
 * Pauses the worker around the downtime announced in locize. Paused, the
 * worker is stopped, so its strategies stay `running` in the store and resume
 * once it is started again. The pause starts PAUSE_LEAD_MS before the announced start (on the
 * backend's clock) or once the maintenance page is up; after at least
 * MIN_SCHEDULED_DOWNTIME_MS, and with the maintenance page down, the backend
 * is probed every PROBE_INTERVAL_MS and the worker resumes after
 * PROBE_SUCCESSES_TO_RESUME successes in a row, plus a random jitter.
 */
export const createPlatformMonitor = ({
  clock,
  random,
  fetchSchedule,
  fetchServerTimeOffset,
  probe,
  pause,
  resume,
  onError,
}: PlatformMonitorOptions): PlatformMonitor => {
  let platform: StrategiesServerPlatform = { status: 'starting', maintenanceAt: null }
  let timer: number | null = null
  let pauseTimer: number | null = null
  let serverTimeOffset = 0
  let successes = 0
  let closed = false
  let scheduleErrorReportedAt: number | null = null
  const listeners = new Set<(platform: StrategiesServerPlatform) => void>()

  const setPlatform = (next: StrategiesServerPlatform) => {
    if (next.status === platform.status && next.maintenanceAt === platform.maintenanceAt) return
    platform = next
    for (const listener of listeners) listener(next)
  }

  const isPaused = () => platform.status === 'down' || platform.status === 'recovering'

  const schedule = (fn: () => void, ms: number) => {
    if (timer !== null) clock.clearTimeout(timer)
    timer = closed ? null : clock.setTimeout(fn, ms)
  }

  const clearPauseTimer = () => {
    if (pauseTimer !== null) clock.clearTimeout(pauseTimer)
    pauseTimer = null
  }

  const enterDown = (maintenanceAt: number | null) => {
    if (isPaused() || closed) return
    clearPauseTimer()
    successes = 0
    setPlatform({ status: 'down', maintenanceAt })
    pause().catch(onError)
    schedule(startRecovering, MIN_SCHEDULED_DOWNTIME_MS)
  }

  const startRecovering = () => {
    setPlatform({ status: 'recovering', maintenanceAt: platform.maintenanceAt })
    void probeOnce()
  }

  const probeOnce = async () => {
    let up = false
    try {
      // locize being unreachable does not hold back a backend that is back.
      const next = await fetchSchedule().catch(() => null)
      if (!next?.inProgress) {
        await probe()
        up = true
      }
    } catch {
      // A failed probe is what recovering expects; it only resets the count.
    }
    if (closed || platform.status !== 'recovering') return
    successes = up ? successes + 1 : 0
    if (successes < PROBE_SUCCESSES_TO_RESUME) {
      schedule(() => void probeOnce(), PROBE_INTERVAL_MS)
      return
    }
    schedule(
      () => {
        successes = 0
        setPlatform({ status: 'up', maintenanceAt: null })
        resume()
        void poll()
      },
      Math.floor(random() * MAX_RESUME_JITTER_MS),
    )
  }

  const serverNow = () => clock.now() + serverTimeOffset

  const reportScheduleError = (error: unknown) => {
    const now = clock.now()
    if (
      scheduleErrorReportedAt !== null &&
      now - scheduleErrorReportedAt < SCHEDULE_ERROR_REPORT_INTERVAL_MS
    )
      return
    scheduleErrorReportedAt = now
    onError(error)
  }

  const pollInterval = () =>
    platform.status === 'scheduled' &&
    platform.maintenanceAt !== null &&
    platform.maintenanceAt - serverNow() <= NEAR_SCHEDULE_MS
      ? ANNOUNCED_SCHEDULE_POLL_INTERVAL_MS
      : SCHEDULE_POLL_INTERVAL_MS

  const poll = async () => {
    let next: MaintenanceSchedule | null = null
    try {
      next = await fetchSchedule()
      scheduleErrorReportedAt = null
    } catch (error) {
      reportScheduleError(error)
    }
    try {
      serverTimeOffset = await fetchServerTimeOffset()
    } catch {
      // Kept from the last answer: the backend may be the one that is down.
    }
    if (closed || isPaused()) return
    if (next === null) {
      // Unreachable at the start, the schedule does not hold the strategies.
      if (platform.status === 'starting') setPlatform({ status: 'up', maintenanceAt: null })
      schedule(() => void poll(), pollInterval())
      return
    }
    const { startsAt, inProgress } = next
    if (inProgress) {
      enterDown(startsAt)
      return
    }
    const now = serverNow()
    if (startsAt === null || startsAt + MIN_SCHEDULED_DOWNTIME_MS <= now) {
      clearPauseTimer()
      setPlatform({ status: 'up', maintenanceAt: null })
      schedule(() => void poll(), SCHEDULE_POLL_INTERVAL_MS)
      return
    }
    if (startsAt - PAUSE_LEAD_MS <= now) {
      enterDown(startsAt)
      return
    }
    setPlatform({ status: 'scheduled', maintenanceAt: startsAt })
    armPause(startsAt)
    schedule(() => void poll(), pollInterval())
  }

  const armPause = (startsAt: number) => {
    clearPauseTimer()
    const pauseAt = startsAt - PAUSE_LEAD_MS
    pauseTimer = clock.setTimeout(
      () => {
        pauseTimer = null
        if (pauseAt > serverNow()) armPause(startsAt)
        else enterDown(startsAt)
      },
      Math.max(0, Math.min(pauseAt - serverNow(), MAX_TIMEOUT_MS)),
    )
  }

  void poll().then(() => {
    if (!closed && !isPaused()) resume()
  })

  return {
    getPlatform: () => platform,
    subscribePlatform: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isPaused,
    allowsUpdate: () =>
      platform.status === 'up' ||
      (platform.status === 'scheduled' &&
        platform.maintenanceAt !== null &&
        platform.maintenanceAt - serverNow() > NEAR_SCHEDULE_MS),
    close: () => {
      closed = true
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
      clearPauseTimer()
    },
  }
}
