import { STRATEGIES_SERVER_RESTART_EXIT_CODE } from './serverHome'

/** A version not ready by then, with a version to go back to, is stopped and replaced by it. */
export const SERVER_READY_TIMEOUT_MS = 120_000

export const SERVER_RESTART_DELAY_MS = 1_000
export const SERVER_RESTART_MAX_DELAY_MS = 60_000
/** A server up this long counts as healthy again: its next crash restarts it after the shortest delay. */
export const SERVER_STABLE_MS = 5 * 60_000

export interface ServerProcessHandlers {
  /** The server listens for clients and its signer is ready, or it has none yet. */
  onReady: () => void
  onExit: (code: number | null) => void
}

export interface LauncherOptions {
  readCurrentVersion: () => string
  writeCurrentVersion: (version: string) => void
  readLastReadyVersion: () => string | null
  writeLastReadyVersion: (version: string) => void
  /** Returns a function that stops the server; its exit is still reported. */
  spawnServer: (version: string, handlers: ServerProcessHandlers) => () => void
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  exit: (code: number) => void
  log: (message: string) => void
  now: () => number
}

export interface Launcher {
  /** The next exit of the server, or the end of a restart delay, ends the launcher. */
  stop: () => void
}

/**
 * Runs the current version of the server. A server that installed a new
 * version exits with STRATEGIES_SERVER_RESTART_EXIT_CODE and the new current
 * version is started; one that exits, or is not ready within
 * SERVER_READY_TIMEOUT_MS, goes back to the last version that was ready.
 * The last ready version is kept in home, so a launcher started after an
 * update (a reboot or a service restart) can go back too. Any other exit
 * restarts the server with a growing delay, unless no version got ready since
 * the launcher started (a broken config), which ends the launcher.
 */
export const runLauncher = ({
  readCurrentVersion,
  writeCurrentVersion,
  readLastReadyVersion,
  writeLastReadyVersion,
  spawnServer,
  setTimeout,
  clearTimeout,
  exit,
  log,
  now,
}: LauncherOptions): Launcher => {
  let lastReady = readLastReadyVersion()
  let keptReady = lastReady
  let readyOnce = false
  let stopping = false
  let restartDelay = SERVER_RESTART_DELAY_MS

  const run = (version: string) => {
    let readyAt: number | null = null
    let readyTimer: unknown = null
    const stopServer = spawnServer(version, {
      onReady: () => {
        if (readyAt !== null) return
        readyAt = now()
        readyOnce = true
        clearTimeout(readyTimer)
        lastReady = version
        if (keptReady === version) return
        try {
          writeLastReadyVersion(version)
          keptReady = version
        } catch (error) {
          log(
            `could not keep ${version} as the last ready strategies server version: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      },
      onExit: (code) => {
        clearTimeout(readyTimer)
        if (stopping) {
          exit(code ?? 0)
          return
        }
        if (code === STRATEGIES_SERVER_RESTART_EXIT_CODE) {
          restartDelay = SERVER_RESTART_DELAY_MS
          run(readCurrentVersion())
          return
        }
        if (readyAt === null && lastReady !== null && lastReady !== version) {
          const previous = lastReady
          log(
            `strategies server ${version} exited with code ${code} before it was ready, going back to ${previous}`,
          )
          writeCurrentVersion(previous)
          run(previous)
          return
        }
        if (!readyOnce) {
          exit(code ?? 1)
          return
        }
        if (readyAt !== null && now() - readyAt >= SERVER_STABLE_MS) {
          restartDelay = SERVER_RESTART_DELAY_MS
        }
        const delay = restartDelay
        restartDelay = Math.min(restartDelay * 2, SERVER_RESTART_MAX_DELAY_MS)
        log(`strategies server ${version} exited with code ${code}, restarting in ${delay / 1000}s`)
        setTimeout(() => {
          if (stopping) exit(0)
          else run(readCurrentVersion())
        }, delay)
      },
    })
    if (readyAt === null && lastReady !== null && lastReady !== version) {
      readyTimer = setTimeout(() => {
        log(
          `strategies server ${version} is not ready after ${SERVER_READY_TIMEOUT_MS}ms, stopping it`,
        )
        stopServer()
      }, SERVER_READY_TIMEOUT_MS)
    }
  }

  run(readCurrentVersion())
  return {
    stop: () => {
      stopping = true
    },
  }
}
