import { describe, expect, it, vi } from 'vitest'
import { STRATEGIES_SERVER_RESTART_EXIT_CODE } from './serverHome'
import {
  SERVER_READY_TIMEOUT_MS,
  SERVER_RESTART_DELAY_MS,
  SERVER_RESTART_MAX_DELAY_MS,
  SERVER_STABLE_MS,
  type ServerProcessHandlers,
  runLauncher,
} from './serverLauncher'

const launch = (initial: string, persistedLastReady: string | null = null) => {
  let current = initial
  let lastReady = persistedLastReady
  let lastReadyWriteError: Error | null = null
  let time = 0
  const timers: { fn: () => void; ms: number }[] = []
  const readyTimers = new Map<number, () => void>()
  let nextReadyTimer = 0
  const spawned: { version: string; handlers: ServerProcessHandlers; stop: () => void }[] = []
  const exit = vi.fn()
  const log = vi.fn()
  const launcher = runLauncher({
    readCurrentVersion: () => current,
    writeCurrentVersion: (version) => {
      current = version
    },
    readLastReadyVersion: () => lastReady,
    writeLastReadyVersion: (version) => {
      if (lastReadyWriteError) throw lastReadyWriteError
      lastReady = version
    },
    spawnServer: (version, handlers) => {
      const stop = vi.fn(() => handlers.onExit(null))
      spawned.push({ version, handlers, stop })
      return stop
    },
    setTimeout: (fn, ms) => {
      if (ms !== SERVER_READY_TIMEOUT_MS) {
        timers.push({ fn, ms })
        return null
      }
      nextReadyTimer += 1
      readyTimers.set(nextReadyTimer, fn)
      return nextReadyTimer
    },
    clearTimeout: (handle) => {
      readyTimers.delete(handle as number)
    },
    exit,
    log,
    now: () => time,
  })
  return {
    launcher,
    spawned,
    timers,
    readyTimers,
    exit,
    log,
    setCurrent: (version: string) => {
      current = version
    },
    getCurrent: () => current,
    getLastReady: () => lastReady,
    failLastReadyWrites: (error: Error | null) => {
      lastReadyWriteError = error
    },
    fireReadyTimers: () => {
      const pending = [...readyTimers.values()]
      readyTimers.clear()
      for (const callback of pending) callback()
    },
    advance: (ms: number) => {
      time += ms
    },
    fireTimer: () => {
      const timer = timers.shift()
      if (!timer) throw new Error('no timer is pending')
      timer.fn()
    },
    last: () => {
      const server = spawned.at(-1)
      if (!server) throw new Error('no server was spawned')
      return server.handlers
    },
  }
}

describe('runLauncher', () => {
  it('starts the version an update installed when the server asks to restart', () => {
    const { spawned, setCurrent, last, exit, timers } = launch('1.0.0')
    last().onReady()
    setCurrent('1.0.1')
    last().onExit(STRATEGIES_SERVER_RESTART_EXIT_CODE)

    expect(spawned.map((s) => s.version)).toEqual(['1.0.0', '1.0.1'])
    expect(timers).toHaveLength(0)
    expect(exit).not.toHaveBeenCalled()
  })

  it('goes back to the last ready version when the new one exits before it is ready', () => {
    const { spawned, setCurrent, getCurrent, last, exit, log } = launch('1.0.0')
    last().onReady()
    setCurrent('1.0.1')
    last().onExit(STRATEGIES_SERVER_RESTART_EXIT_CODE)
    last().onExit(1)

    expect(spawned.map((s) => s.version)).toEqual(['1.0.0', '1.0.1', '1.0.0'])
    expect(getCurrent()).toBe('1.0.0')
    expect(log).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
  })

  it('exits with the code of a server when no version was ever ready', () => {
    const first = launch('1.0.0')
    first.last().onExit(null)
    expect(first.exit).toHaveBeenCalledWith(1)
    expect(first.spawned).toHaveLength(1)
    expect(first.timers).toHaveLength(0)
  })

  it('restarts a crashed server after a delay that doubles up to the maximum', () => {
    const { spawned, timers, last, fireTimer, exit } = launch('1.0.0')
    last().onReady()
    last().onExit(3)
    expect(timers.map((t) => t.ms)).toEqual([SERVER_RESTART_DELAY_MS])
    expect(spawned).toHaveLength(1)

    fireTimer()
    expect(spawned.map((s) => s.version)).toEqual(['1.0.0', '1.0.0'])

    const delays: number[] = []
    for (let i = 0; i < 10; i++) {
      last().onExit(1)
      delays.push(timers[0]?.ms ?? 0)
      fireTimer()
    }
    expect(delays.slice(0, 3)).toEqual([
      SERVER_RESTART_DELAY_MS * 2,
      SERVER_RESTART_DELAY_MS * 4,
      SERVER_RESTART_DELAY_MS * 8,
    ])
    expect(delays.at(-1)).toBe(SERVER_RESTART_MAX_DELAY_MS)
    expect(exit).not.toHaveBeenCalled()
  })

  it('goes back to the shortest delay once a restarted server stayed up', () => {
    const { timers, last, fireTimer, advance } = launch('1.0.0')
    last().onReady()
    last().onExit(1)
    fireTimer()
    last().onExit(1)
    expect(timers[0]?.ms).toBe(SERVER_RESTART_DELAY_MS * 2)
    fireTimer()

    last().onReady()
    advance(SERVER_STABLE_MS)
    last().onExit(1)
    expect(timers[0]?.ms).toBe(SERVER_RESTART_DELAY_MS)
  })

  it('restarts on the current version, which a crash does not change', () => {
    const { spawned, setCurrent, last, fireTimer } = launch('1.0.0')
    last().onReady()
    setCurrent('1.0.1')
    last().onExit(STRATEGIES_SERVER_RESTART_EXIT_CODE)
    last().onReady()
    last().onExit(1)
    fireTimer()

    expect(spawned.map((s) => s.version)).toEqual(['1.0.0', '1.0.1', '1.0.1'])
  })

  it('exits instead of restarting or going back once stopped', () => {
    const { launcher, spawned, setCurrent, last, exit } = launch('1.0.0')
    last().onReady()
    setCurrent('1.0.1')
    last().onExit(STRATEGIES_SERVER_RESTART_EXIT_CODE)
    launcher.stop()
    last().onExit(null)

    expect(spawned).toHaveLength(2)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits at the end of a restart delay when stopped during it', () => {
    const { launcher, spawned, last, fireTimer, exit } = launch('1.0.0')
    last().onReady()
    last().onExit(1)
    launcher.stop()
    fireTimer()

    expect(spawned).toHaveLength(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('stops a new version that is not ready in time and goes back to the last ready one', () => {
    const { spawned, setCurrent, getCurrent, last, exit, fireReadyTimers } = launch('1.0.0')
    last().onReady()
    setCurrent('1.0.1')
    last().onExit(STRATEGIES_SERVER_RESTART_EXIT_CODE)
    fireReadyTimers()

    expect(spawned[1]?.stop).toHaveBeenCalledOnce()
    expect(spawned.map((s) => s.version)).toEqual(['1.0.0', '1.0.1', '1.0.0'])
    expect(getCurrent()).toBe('1.0.0')
    expect(exit).not.toHaveBeenCalled()
  })

  it('keeps a new version that gets ready in time, and never times out one with nothing to go back to', () => {
    const updated = launch('1.0.0')
    expect(updated.readyTimers.size).toBe(0)
    updated.last().onReady()
    updated.setCurrent('1.0.1')
    updated.last().onExit(STRATEGIES_SERVER_RESTART_EXIT_CODE)
    expect(updated.readyTimers.size).toBe(1)
    updated.last().onReady()

    expect(updated.readyTimers.size).toBe(0)
    expect(updated.spawned.map((s) => s.version)).toEqual(['1.0.0', '1.0.1'])
  })

  it('keeps the version that got ready in home', () => {
    const { last, getLastReady } = launch('1.0.0')
    expect(getLastReady()).toBeNull()
    last().onReady()
    expect(getLastReady()).toBe('1.0.0')
  })

  it('keeps a version that got ready running when home cannot keep it', () => {
    const { spawned, setCurrent, last, exit, log, readyTimers, getLastReady, failLastReadyWrites } =
      launch('1.0.0', '0.9.0')
    failLastReadyWrites(new Error('ENOSPC: no space left on device'))

    expect(() => last().onReady()).not.toThrow()
    expect(readyTimers.size).toBe(0)
    expect(getLastReady()).toBe('0.9.0')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'))

    setCurrent('1.0.1')
    last().onExit(STRATEGIES_SERVER_RESTART_EXIT_CODE)
    last().onExit(1)

    expect(spawned.map((s) => s.version)).toEqual(['1.0.0', '1.0.1', '1.0.0'])
    expect(exit).not.toHaveBeenCalled()
  })

  it('keeps the version in home once a write fails and the same version gets ready again', () => {
    const { last, fireTimer, getLastReady, failLastReadyWrites } = launch('1.0.0', '0.9.0')
    failLastReadyWrites(new Error('ENOSPC: no space left on device'))
    last().onReady()
    expect(getLastReady()).toBe('0.9.0')

    failLastReadyWrites(null)
    last().onExit(1)
    fireTimer()
    last().onReady()

    expect(getLastReady()).toBe('1.0.0')
  })

  it('goes back to the kept last ready version when a new launcher starts a version that exits before it is ready', () => {
    const { spawned, getCurrent, last, exit } = launch('1.0.1', '1.0.0')
    last().onExit(1)

    expect(spawned.map((s) => s.version)).toEqual(['1.0.1', '1.0.0'])
    expect(getCurrent()).toBe('1.0.0')
    expect(exit).not.toHaveBeenCalled()
  })

  it('times out a version a new launcher starts that is not the kept last ready one', () => {
    const { spawned, getCurrent, readyTimers, fireReadyTimers } = launch('1.0.1', '1.0.0')
    expect(readyTimers.size).toBe(1)
    fireReadyTimers()

    expect(spawned.map((s) => s.version)).toEqual(['1.0.1', '1.0.0'])
    expect(getCurrent()).toBe('1.0.0')
  })

  it('exits when the kept last ready version is not ready again after a launcher start', () => {
    const { spawned, last, exit } = launch('1.0.0', '1.0.0')
    last().onExit(1)

    expect(exit).toHaveBeenCalledWith(1)
    expect(spawned).toHaveLength(1)
  })
})
