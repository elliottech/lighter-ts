import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../engine/testUtils'
import type { MaintenanceSchedule } from './maintenanceSchedule'
import {
  ANNOUNCED_SCHEDULE_POLL_INTERVAL_MS,
  MIN_SCHEDULED_DOWNTIME_MS,
  NEAR_SCHEDULE_MS,
  PAUSE_LEAD_MS,
  PROBE_INTERVAL_MS,
  PROBE_SUCCESSES_TO_RESUME,
  SCHEDULE_ERROR_REPORT_INTERVAL_MS,
  SCHEDULE_POLL_INTERVAL_MS,
  createPlatformMonitor,
} from './platformMonitor'

const flush = () => new Promise((resolve) => setTimeout(resolve))

const make = (initial: MaintenanceSchedule, serverTimeOffset = 0, locizeReachable = true) => {
  const clock = new FakeClock()
  let schedule = initial
  let backendUp = true
  let locizeUp = locizeReachable
  const pause = vi.fn(() => Promise.resolve())
  const resume = vi.fn()
  const onError = vi.fn()
  const probe = vi.fn(() => (backendUp ? Promise.resolve() : Promise.reject(new Error('down'))))
  const monitor = createPlatformMonitor({
    clock,
    random: () => 0.5,
    fetchSchedule: () =>
      locizeUp ? Promise.resolve(schedule) : Promise.reject(new Error('locize down')),
    fetchServerTimeOffset: () => Promise.resolve(serverTimeOffset),
    probe,
    pause,
    resume,
    onError,
  })
  return {
    clock,
    monitor,
    pause,
    resume,
    probe,
    onError,
    setSchedule: (next: MaintenanceSchedule) => {
      schedule = next
    },
    setBackendUp: (up: boolean) => {
      backendUp = up
    },
    setLocizeUp: (up: boolean) => {
      locizeUp = up
    },
  }
}

/** Fires the next timer and lets the poll or probe it starts settle. */
const tick = async (clock: FakeClock) => {
  clock.fireNext()
  await flush()
}

describe('createPlatformMonitor', () => {
  it('is starting until the first check answers, then reports what it found', async () => {
    const { monitor, resume } = make({ startsAt: null, inProgress: false })
    const listener = vi.fn()
    monitor.subscribePlatform(listener)

    expect(monitor.getPlatform()).toEqual({ status: 'starting', maintenanceAt: null })
    expect(resume).not.toHaveBeenCalled()
    await flush()

    expect(monitor.getPlatform()).toEqual({ status: 'up', maintenanceAt: null })
    expect(listener).toHaveBeenCalledWith({ status: 'up', maintenanceAt: null })
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('is up once the first check could not reach locize, since it resumes anyway', async () => {
    const { monitor, resume } = make({ startsAt: null, inProgress: false }, 0, false)
    await flush()

    expect(monitor.getPlatform()).toEqual({ status: 'up', maintenanceAt: null })
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('reports a failing schedule fetch once an hour, and at once when it fails again later', async () => {
    const { clock, monitor, onError, setLocizeUp } = make(
      { startsAt: null, inProgress: false },
      0,
      false,
    )
    await flush()
    expect(onError).toHaveBeenCalledTimes(1)

    while (clock.now() < SCHEDULE_ERROR_REPORT_INTERVAL_MS) await tick(clock)
    expect(onError).toHaveBeenCalledTimes(2)
    expect(clock.now()).toBe(SCHEDULE_ERROR_REPORT_INTERVAL_MS)
    await tick(clock)
    expect(onError).toHaveBeenCalledTimes(2)

    setLocizeUp(true)
    await tick(clock)
    expect(monitor.getPlatform().status).toBe('up')
    setLocizeUp(false)
    await tick(clock)
    expect(onError).toHaveBeenCalledTimes(3)
  })

  it('polls every 5 minutes while nothing is announced', async () => {
    const { clock, monitor } = make({ startsAt: null, inProgress: false })
    await flush()

    expect(monitor.getPlatform()).toEqual({ status: 'up', maintenanceAt: null })
    expect(clock.nextDueAt()).toBe(SCHEDULE_POLL_INTERVAL_MS)
  })

  it('pauses a minute before the announced start, on the backend clock', async () => {
    const startsAt = 15 * 60_000
    const offset = 2 * 60_000
    const { clock, monitor, pause } = make({ startsAt, inProgress: false }, offset)
    await flush()

    expect(monitor.getPlatform()).toEqual({ status: 'scheduled', maintenanceAt: startsAt })
    while (!monitor.isPaused()) await tick(clock)

    expect(clock.now()).toBe(startsAt - PAUSE_LEAD_MS - offset)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(monitor.getPlatform()).toEqual({ status: 'down', maintenanceAt: startsAt })
  })

  it('stays up after the downtime while the timer key is left at the past start', async () => {
    const startsAt = 10 * 60_000
    const { clock, monitor, pause, resume } = make({ startsAt, inProgress: false })
    await flush()
    while (!monitor.isPaused()) await tick(clock)
    while (monitor.isPaused()) await tick(clock)
    expect(resume).toHaveBeenCalledTimes(2)

    for (let i = 0; i < 5; i++) await tick(clock)

    expect(monitor.getPlatform()).toEqual({ status: 'up', maintenanceAt: null })
    expect(clock.nextDueAt()).toBe(clock.now() + SCHEDULE_POLL_INTERVAL_MS)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it('resumes the supervisor once the first check finds no maintenance in progress', async () => {
    const idle = make({ startsAt: null, inProgress: false })
    const announced = make({ startsAt: 60 * 60_000, inProgress: false })
    expect(idle.resume).not.toHaveBeenCalled()
    await flush()

    expect(idle.resume).toHaveBeenCalledTimes(1)
    expect(announced.resume).toHaveBeenCalledTimes(1)
  })

  it('resumes the supervisor when locize does not answer the first check', async () => {
    const made = make({ startsAt: null, inProgress: false })
    made.setLocizeUp(false)
    await flush()

    expect(made.resume).toHaveBeenCalledTimes(1)
    expect(made.monitor.getPlatform()).toEqual({ status: 'up', maintenanceAt: null })
  })

  it('pauses at once, without resuming, when the first check is inside the lead minute', async () => {
    const startsAt = PAUSE_LEAD_MS / 2
    const { monitor, pause, resume } = make({ startsAt, inProgress: false })
    await flush()

    expect(monitor.getPlatform()).toEqual({ status: 'down', maintenanceAt: startsAt })
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  it('pauses at once when the first check finds a start that elapsed less than 5 minutes ago', async () => {
    const startsAt = 10 * 60_000
    const { monitor, pause, resume } = make({ startsAt, inProgress: false }, startsAt + 2 * 60_000)
    await flush()

    expect(monitor.getPlatform()).toEqual({ status: 'down', maintenanceAt: startsAt })
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  it('resumes when the first check finds a start that elapsed 5 minutes ago or more', async () => {
    const startsAt = 10 * 60_000
    const { monitor, pause, resume } = make(
      { startsAt, inProgress: false },
      startsAt + MIN_SCHEDULED_DOWNTIME_MS,
    )
    await flush()

    expect(monitor.getPlatform()).toEqual({ status: 'up', maintenanceAt: null })
    expect(pause).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('keeps polling every 5 minutes while the announced start is days away', async () => {
    const { clock, monitor } = make({ startsAt: 3 * 24 * 60 * 60_000, inProgress: false })
    await flush()

    expect(monitor.getPlatform().status).toBe('scheduled')
    expect(clock.nextDueAt()).toBe(SCHEDULE_POLL_INTERVAL_MS)
  })

  it('pauses a minute before a start announced further away than a timeout can reach', async () => {
    const startsAt = 30 * 24 * 60 * 60_000
    const { clock, monitor, pause, setLocizeUp } = make({ startsAt, inProgress: false })
    await flush()
    setLocizeUp(false)

    clock.advance(startsAt - PAUSE_LEAD_MS - 2 * SCHEDULE_POLL_INTERVAL_MS)
    while (!monitor.isPaused()) await tick(clock)

    expect(clock.now()).toBe(startsAt - PAUSE_LEAD_MS)
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('allows an update only while up or the announced start is more than 15 minutes away', async () => {
    const startsAt = 30 * 60_000
    const { clock, monitor, setSchedule } = make({ startsAt, inProgress: false })
    expect(monitor.allowsUpdate()).toBe(false)
    await flush()
    expect(monitor.allowsUpdate()).toBe(true)

    clock.advance(startsAt - NEAR_SCHEDULE_MS - 1)
    expect(monitor.allowsUpdate()).toBe(true)
    clock.advance(1)
    expect(monitor.allowsUpdate()).toBe(false)

    setSchedule({ startsAt, inProgress: true })
    await tick(clock)
    expect(monitor.isPaused()).toBe(true)
    expect(monitor.allowsUpdate()).toBe(false)
  })

  it('allows no update while the first check finds maintenance in progress', async () => {
    const { monitor } = make({ startsAt: null, inProgress: true })
    await flush()

    expect(monitor.isPaused()).toBe(true)
    expect(monitor.allowsUpdate()).toBe(false)
  })

  it('polls every minute once the announced start is 15 minutes away or less', async () => {
    const startsAt = 30 * 60_000
    const { clock } = make({ startsAt, inProgress: false })
    await flush()
    expect(clock.nextDueAt()).toBe(SCHEDULE_POLL_INTERVAL_MS)

    while (clock.now() < startsAt - NEAR_SCHEDULE_MS) await tick(clock)

    expect(clock.now()).toBe(startsAt - NEAR_SCHEDULE_MS)
    expect(clock.nextDueAt()).toBe(clock.now() + ANNOUNCED_SCHEDULE_POLL_INTERVAL_MS)
  })

  it('pauses at once while the maintenance page is up, and probes only after it is down', async () => {
    const { clock, monitor, pause, resume, probe, setSchedule } = make({
      startsAt: 0,
      inProgress: true,
    })
    await flush()
    expect(pause).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    expect(clock.nextDueAt()).toBe(MIN_SCHEDULED_DOWNTIME_MS)

    await tick(clock)
    expect(monitor.getPlatform().status).toBe('recovering')
    await tick(clock)
    expect(probe).not.toHaveBeenCalled()

    setSchedule({ startsAt: 0, inProgress: false })
    for (let i = 0; i < PROBE_SUCCESSES_TO_RESUME; i++) await tick(clock)
    expect(probe).toHaveBeenCalledTimes(PROBE_SUCCESSES_TO_RESUME)
    expect(resume).not.toHaveBeenCalled()

    const resumeAt = clock.nextDueAt()
    await tick(clock)
    expect(resumeAt).toBe(clock.now())
    expect(resume).toHaveBeenCalledTimes(1)
    expect(monitor.getPlatform()).toEqual({ status: 'up', maintenanceAt: null })
  })

  it('needs consecutive successful probes: a failure starts the count again', async () => {
    const made = make({ startsAt: 0, inProgress: true })
    await flush()
    expect(made.monitor.getPlatform()).toEqual({ status: 'down', maintenanceAt: 0 })
    made.setSchedule({ startsAt: 0, inProgress: false })
    await tick(made.clock)
    expect(made.monitor.getPlatform().status).toBe('recovering')
    for (let i = 0; i < PROBE_SUCCESSES_TO_RESUME - 2; i++) await tick(made.clock)
    made.setBackendUp(false)
    await tick(made.clock)
    made.setBackendUp(true)
    for (let i = 0; i < PROBE_SUCCESSES_TO_RESUME - 1; i++) await tick(made.clock)
    expect(made.resume).not.toHaveBeenCalled()
    expect(made.clock.nextDueAt()).toBe(made.clock.now() + PROBE_INTERVAL_MS)
    await tick(made.clock)
    await tick(made.clock)
    expect(made.resume).toHaveBeenCalledTimes(1)
  })
})
