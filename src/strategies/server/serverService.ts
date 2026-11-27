import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import {
  LAUNCHER_LOCK_FILE,
  SERVER_DB_FILE,
  type ServerDb,
  ServerDbLockedError,
  lockServerHome,
  openServerDb,
} from './serverDb'
import { readPersistedStrategies } from './persistedStrategies'
import { checkRegisteredAccountIndex } from './serverConfig'
import { checkStoreDir } from './serverEnv'
import { VERSION_FILES, versionsDir } from './serverHome'
import { serverLogsDir } from './serverLogs'
import { STRATEGY_STORE_KEY } from '../store/strategyStoreKey'
import { TLS_DIR } from './serverTls'

export const SYSTEMD_UNIT = 'lighter-strategies-server'
export const LAUNCHD_LABEL = 'xyz.lighter.strategies-server'
/** Where the service runs the launcher from: the npx cache that started install-service can be cleared. */
export const SERVICE_LAUNCHER = 'launcher.mjs'
/** Where launchd writes the launcher's own output, as the journal does on Linux. */
export const SERVICE_LAUNCHER_LOG = 'launcher.log'
/** Set to 1 for the launcher the service runs from home, with no package around it. */
export const SERVICE_ENV_FLAG = 'STRATEGIES_SERVER_SERVICE'
/** How long uninstall-service waits for the stopped service to release its locks. */
export const UNINSTALL_LOCK_WAIT_MS = 15_000
export const UNINSTALL_LOCK_RETRY_MS = 500

export interface ServiceTarget {
  node: string
  launcher: string
  home: string
}

const systemdQuote = (value: string): string =>
  `"${value.replace(/[\\"]/g, (char) => `\\${char}`).replace(/%/g, '%%')}"`

export const systemdUnit = ({ node, launcher, home }: ServiceTarget): string => `[Unit]
Description=Lighter strategies server
StartLimitIntervalSec=0

[Service]
WorkingDirectory=${home.replace(/%/g, '%%')}
Environment=${systemdQuote(`STRATEGIES_SERVER_HOME=${home}`)}
Environment=${systemdQuote(`${SERVICE_ENV_FLAG}=1`)}
ExecStart=${systemdQuote(node)} ${systemdQuote(launcher)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`

const xmlEscape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char,
  )

export const launchdPlist = ({ node, launcher, home }: ServiceTarget): string => {
  const string = (value: string) => `<string>${xmlEscape(value)}</string>`
  const log = string(join(home, SERVICE_LAUNCHER_LOG))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(LAUNCHD_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${string(node)}
    ${string(launcher)}
  </array>
  <key>WorkingDirectory</key>
  ${string(home)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>STRATEGIES_SERVER_HOME</key>
    ${string(home)}
    <key>${SERVICE_ENV_FLAG}</key>
    ${string('1')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  ${log}
  <key>StandardErrorPath</key>
  ${log}
</dict>
</plist>
`
}

const systemdUnitPath = () =>
  join(homedir(), '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.service`)
const launchdPlistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
const launchdGuiDomain = () => `gui/${userInfo().uid}`
const launchdUserDomain = () => `user/${userInfo().uid}`
const bootoutLaunchd = () => {
  for (const domain of [launchdGuiDomain(), launchdUserDomain()]) {
    tryRun('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`])
  }
}

const run = (command: string, args: string[]) => {
  execFileSync(command, args, { stdio: 'inherit' })
}

const tryRun = (command: string, args: string[]): boolean => {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const retryWhileLocked = <T>(take: () => T, sleep: (ms: number) => void): T => {
  for (let waited = 0; ; waited += UNINSTALL_LOCK_RETRY_MS) {
    try {
      return take()
    } catch (error) {
      if (!(error instanceof ServerDbLockedError) || waited >= UNINSTALL_LOCK_WAIT_MS) throw error
    }
    sleep(UNINSTALL_LOCK_RETRY_MS)
  }
}

const explainLocked = <T>(open: () => T): T => {
  try {
    return open()
  } catch (error) {
    if (!(error instanceof ServerDbLockedError)) throw error
    throw new Error(`${error.message}: stop the running server first`)
  }
}

/** Locks the store, retrying for `UNINSTALL_LOCK_WAIT_MS` when given `sleep`, and returns its release. */
const holdStore = (storeDir: string, sleep?: (ms: number) => void): (() => void) =>
  explainLocked(() => {
    const open = () => openServerDb(storeDir).release
    return sleep ? retryWhileLocked(open, sleep) : open()
  })

/** The account of the store's signer, or of its pending one while a registration is in progress. */
const readRegisteredAccountIndex = (storeDir: string): number | null => {
  const db: ServerDb = explainLocked(() => openServerDb(storeDir))
  try {
    return db.readSigner()?.accountIndex ?? db.readPendingSigner()?.accountIndex ?? null
  } finally {
    db.release()
  }
}

const systemdActiveState = (): string => {
  try {
    return execFileSync(
      'systemctl',
      ['--user', 'show', '-p', 'ActiveState', '--value', SYSTEMD_UNIT],
      {
        encoding: 'utf8',
      },
    ).trim()
  } catch {
    return 'unknown'
  }
}

/** Stops the service, and returns how to start it again when it was running or about to restart. */
const stopService = (): (() => void) | null => {
  if (process.platform === 'linux') {
    // A unit waiting out RestartSec is `activating`, and the stop below cancels that restart.
    const running = ['active', 'activating', 'reloading'].includes(systemdActiveState())
    tryRun('systemctl', ['--user', 'stop', SYSTEMD_UNIT])
    return running ? () => tryRun('systemctl', ['--user', 'start', SYSTEMD_UNIT]) : null
  }
  const loadedIn = [launchdGuiDomain(), launchdUserDomain()].find((domain) =>
    tryRun('launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`]),
  )
  bootoutLaunchd()
  return loadedIn ? () => tryRun('launchctl', ['bootstrap', loadedIn, launchdPlistPath()]) : null
}

export const assertStoreFree = (storeDir: string) => holdStore(storeDir)()

/** The store a service whose home .env is `envFile` runs on: it resolves relative paths against home. */
export const envStoreDir = (home: string, envFile: string): string =>
  resolve(home, parseEnv(readFileSync(envFile, 'utf8')).STRATEGIES_STORE_DIR?.trim() || 'store')

export interface InstallServiceOptions {
  home: string
  node: string
  /** The launcher running install-service, copied into home. */
  ownLauncher: string
  /** The config the service starts with, copied into home as .env. */
  envFile: string
  /** STRATEGIES_WS_ALLOWED_ACCOUNT_INDEX of that config, null for any account. */
  allowedAccountIndex: number | null
  log: (message: string) => void
}

export const installService = ({
  home,
  node,
  ownLauncher,
  envFile,
  allowedAccountIndex,
  log,
}: InstallServiceOptions) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(`install-service supports Linux and macOS, not ${process.platform}`)
  }
  const homeEnv = join(home, '.env')
  const serviceEnv = existsSync(envFile) ? resolve(envFile) : homeEnv
  if (!existsSync(serviceEnv)) {
    throw new Error(
      `No .env to start the service with: run install-service from the directory that holds it`,
    )
  }
  const storeDir = checkStoreDir(envStoreDir(home, serviceEnv), [home, dirname(serviceEnv)])
  const installed = existsSync(
    process.platform === 'linux' ? systemdUnitPath() : launchdPlistPath(),
  )
  if (installed && serviceEnv !== homeEnv && existsSync(homeEnv)) {
    const installedStoreDir = envStoreDir(home, homeEnv)
    if (installedStoreDir !== storeDir) {
      throw new Error(
        `The installed service runs on the store in ${installedStoreDir}, ${serviceEnv} points to ${storeDir}: run uninstall-service first to change it`,
      )
    }
  }
  // An installed service holds the lock itself: stop it before checking.
  const restart = stopService()
  const registeredAccountIndex = readRegisteredAccountIndex(storeDir)
  try {
    checkRegisteredAccountIndex(allowedAccountIndex, registeredAccountIndex)
  } catch (error) {
    // Nothing is replaced yet: a service that was running starts again as it was.
    restart?.()
    throw error
  }

  const launcher = join(home, SERVICE_LAUNCHER)
  if (resolve(ownLauncher) !== launcher) copyFileSync(ownLauncher, launcher)
  chmodSync(launcher, 0o755)

  if (serviceEnv !== homeEnv) {
    copyFileSync(serviceEnv, homeEnv)
    log(`copied ${serviceEnv} to ${homeEnv}`)
  }
  chmodSync(homeEnv, 0o600)
  log(`the service runs on the store in ${storeDir}`)

  const target = { node, launcher, home }
  if (process.platform === 'linux') {
    const path = systemdUnitPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, systemdUnit(target))
    run('systemctl', ['--user', 'daemon-reload'])
    run('systemctl', ['--user', 'enable', SYSTEMD_UNIT])
    run('systemctl', ['--user', 'restart', SYSTEMD_UNIT])
    const lingers = (() => {
      try {
        return (
          execFileSync('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value'], {
            encoding: 'utf8',
          }).trim() === 'yes'
        )
      } catch {
        return false
      }
    })()
    if (!lingers && !tryRun('loginctl', ['enable-linger'])) {
      log(
        `The service only runs while you are logged in. To start it at boot, run: sudo loginctl enable-linger ${userInfo().username}`,
      )
    }
    log(
      `installed ${path}, logs: ${serverLogsDir(home)}; journalctl --user -u ${SYSTEMD_UNIT} shows only launcher events (restarts, rollbacks, logging failures)`,
    )
  } else {
    const path = launchdPlistPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, launchdPlist(target))
    let domain = launchdGuiDomain()
    if (!tryRun('launchctl', ['print', domain])) {
      domain = launchdUserDomain()
      log(
        `No desktop login for ${userInfo().username}, so the service is installed in ${domain}: it only runs while you are logged in and does not start at boot. Log in on the desktop and run install-service again for it to run in ${launchdGuiDomain()}`,
      )
    }
    run('launchctl', ['bootstrap', domain, path])
    log(
      `installed ${path}, logs: ${serverLogsDir(home)}; ${join(home, SERVICE_LAUNCHER_LOG)} holds only launcher events (restarts, rollbacks, logging failures)`,
    )
  }
}

const isWithin = (dir: string, parent: string): boolean => {
  const path = relative(resolve(parent), resolve(dir))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export const DELETE_RUNNING_STRATEGIES_FLAG = '--delete-running-strategies'

const countRunningStrategies = (storeDir: string): number => {
  let strategies: ReturnType<typeof readPersistedStrategies>
  try {
    strategies = readPersistedStrategies(storeDir, STRATEGY_STORE_KEY)
  } catch (error) {
    throw new Error(
      `Cannot read the strategies in ${storeDir}: ${error instanceof Error ? error.message : String(error)}. Run uninstall-service ${DELETE_RUNNING_STRATEGIES_FLAG} to delete the store anyway`,
    )
  }
  return Object.values(strategies).filter((record) => record.progress?.status === 'running').length
}

const runningStrategies = (count: number) =>
  `${count} ${count === 1 ? 'strategy is' : 'strategies are'} still running`

const assertNoRunningStrategies = (storeDir: string, serviceRemoved = false) => {
  const count = countRunningStrategies(storeDir)
  if (count > 0) {
    const them = count === 1 ? 'it' : 'them'
    throw new Error(
      serviceRemoved
        ? `${runningStrategies(count)} in ${storeDir}, and the service is already removed: run install-service again to stop ${them} from a frontend, then uninstall-service, or run uninstall-service ${DELETE_RUNNING_STRATEGIES_FLAG}`
        : `${runningStrategies(count)} in ${storeDir}: stop ${them} first, so no order is left on the book without a record, or run uninstall-service ${DELETE_RUNNING_STRATEGIES_FLAG}`,
    )
  }
}

/** What a launcher writes into home. Anything else, such as a store the home .env doesn't name, keeps home. */
const homeEntries = (home: string) => [
  join(home, '.env'),
  join(home, SERVICE_LAUNCHER),
  join(home, SERVICE_LAUNCHER_LOG),
  ...VERSION_FILES.map((file) => join(home, file)),
  versionsDir(home),
  serverLogsDir(home),
  // Last, so a launcher started meanwhile fails on the lock or finds nothing left to run.
  join(home, LAUNCHER_LOCK_FILE),
  join(home, `${LAUNCHER_LOCK_FILE}-journal`),
]

const warnRunningStrategies = (storeDir: string, log: (message: string) => void) => {
  let count: number
  try {
    count = countRunningStrategies(storeDir)
  } catch {
    log(
      `cannot read the strategies in ${storeDir}, deleting the store anyway: cancel any order its strategies left on the book`,
    )
    return
  }
  if (count > 0) {
    log(
      `${runningStrategies(count)} in ${storeDir}, deleting the store anyway: ${count === 1 ? 'its' : 'their'} resting orders stay on the book until you cancel them`,
    )
  }
}

export const uninstallService = ({
  home,
  log,
  deleteRunningStrategies = false,
  sleep = sleepSync,
}: {
  home: string
  log: (message: string) => void
  /** Deletes the store even while it holds running strategies, leaving their orders on the book. */
  deleteRunningStrategies?: boolean
  sleep?: (ms: number) => void
}) => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error(`uninstall-service supports Linux and macOS, not ${process.platform}`)
  }
  const homeEnv = join(home, '.env')
  const storeDir = existsSync(homeEnv) ? envStoreDir(home, homeEnv) : join(home, 'store')
  for (const dir of [home, storeDir]) {
    if (isWithin(homedir(), dir)) {
      throw new Error(`${dir} holds your home directory, so uninstall-service does not delete it`)
    }
  }
  // Only dirs a server has run from are deleted, so a mistyped path survives. Checked before
  // lockServerHome, which creates the lock file.
  const deletesHome = existsSync(join(home, LAUNCHER_LOCK_FILE))
  const storeExists = existsSync(storeDir)
  const deletesStore =
    storeExists &&
    ((deletesHome && isWithin(storeDir, home)) || existsSync(join(storeDir, SERVER_DB_FILE)))
  if (deletesStore && !deleteRunningStrategies) assertNoRunningStrategies(storeDir)

  if (process.platform === 'linux') {
    tryRun('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
    rmSync(systemdUnitPath(), { force: true })
    tryRun('systemctl', ['--user', 'daemon-reload'])
  } else {
    bootoutLaunchd()
    rmSync(launchdPlistPath(), { force: true })
  }
  log('removed the service')

  // The locks are held until the deletes, so no server can open the store in between.
  const held: Array<() => void> = []
  try {
    if (deletesStore) {
      // The stopped service can still hold the store for a few seconds.
      held.push(holdStore(storeDir, sleep))
      if (deleteRunningStrategies) warnRunningStrategies(storeDir, log)
      else assertNoRunningStrategies(storeDir, true)
    }
    if (deletesHome) {
      try {
        held.push(retryWhileLocked(() => lockServerHome(home), sleep))
      } catch (error) {
        if (!(error instanceof ServerDbLockedError)) throw error
        throw new Error(`A strategies server runs from ${home}: stop it first`)
      }
    }
    if (!storeExists) {
      log(`no store in ${storeDir}`)
    } else if (deletesStore) {
      rmSync(storeDir, { recursive: true, force: true })
      log(`deleted the store in ${storeDir}`)
    } else {
      log(`kept ${storeDir}, which holds no strategies server store`)
    }
    if (!deletesHome) {
      log(`kept ${home}, which holds no strategies server`)
      return
    }
    for (const entry of homeEntries(home)) rmSync(entry, { recursive: true, force: true })
    // Gone already when the store was home itself, which an older install allowed.
    const left = existsSync(home) ? readdirSync(home) : []
    // Let's Encrypt issues 5 certificates per IP a week, so a reinstall reuses the kept one.
    if (left.length === 1 && left[0] === TLS_DIR) {
      log(`deleted ${home}, keeping the TLS certificate in ${join(home, TLS_DIR)}`)
      return
    }
    if (left.length > 0) {
      log(`kept ${home}, which still holds ${left.join(', ')}`)
      return
    }
    rmSync(home, { recursive: true, force: true })
    log(`deleted ${home}`)
  } finally {
    for (const release of held.reverse()) release()
  }
}
