// `strategies-server` bin: runs the installed version of the strategies
// server from STRATEGIES_SERVER_HOME, installing the one it ships with on the
// first run, and restarts it on the version an `update` installed or after it
// crashed. `strategies-server install-service` runs it as a systemd user
// service (Linux) or a launchd agent (macOS); `uninstall-service` removes it
// and deletes STRATEGIES_SERVER_HOME and the store, seed included, keeping
// only the TLS certificate. It refuses while a strategy is running, unless
// given --delete-running-strategies.
// With STRATEGIES_TLS_IP set, install-service first gets the Let's Encrypt
// certificate the server then serves wss:// with and renews.

import { type ChildProcess, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SERVER_ENTRY,
  readCurrentVersion,
  readLastReadyVersion,
  versionDir,
  versionsDir,
  writeCurrentVersion,
  writeLastReadyVersion,
} from './serverHome'
import { ServerDbLockedError, lockServerHome } from './serverDb'
import { checkStoreDir, readEnv, readIntEnv } from './serverEnv'
import { runLauncher } from './serverLauncher'
import {
  DEFAULT_SERVER_LOGS_MAX_MB,
  MAX_SERVER_LOGS_MAX_MB,
  MIN_SERVER_LOGS_MAX_MB,
  SERVER_LOGS_MAX_MB_ENV,
  type ServerLogWriter,
  createServerLogWriter,
  createServerOutputTee,
  serverLogsDir,
  serverLogsMaxBytes,
} from './serverLogs'
import {
  DELETE_RUNNING_STRATEGIES_FLAG,
  SERVICE_ENV_FLAG,
  installService,
  uninstallService,
} from './serverService'
import { readAllowedAccountIndex, readWsPort } from './serverConfig'
import { ensureTlsCertificate, readTlsSettings } from './serverTls'

if (existsSync('.env')) process.loadEnvFile('.env')

const home = readEnv('STRATEGIES_SERVER_HOME') ?? join(homedir(), '.lighter-strategies-server')
const storeDir = readEnv('STRATEGIES_STORE_DIR') ?? join(home, 'store')
const ownFile = fileURLToPath(import.meta.url)
const ownDir = dirname(ownFile)
const ownPackage = join(ownDir, '..', '..', 'package.json')
let logWriter: ServerLogWriter | null = null
const log = (message: string) => {
  process.stderr.write(`${message}\n`)
  logWriter?.write('launcher', 'err', `${message}\n`)
}
const asService = readEnv(SERVICE_ENV_FLAG) === '1'
const SERVER_OUTPUT_DRAIN_MS = 1_000

const ownVersion = (): string =>
  (JSON.parse(readFileSync(ownPackage, 'utf8')) as { version: string }).version

const installOwnVersion = (): string => {
  if (asService) throw new Error(`No strategies server is installed in ${home}`)
  const version = ownVersion()
  const target = versionDir(home, version)
  if (!existsSync(join(target, SERVER_ENTRY))) {
    mkdirSync(versionsDir(home), { recursive: true, mode: 0o700 })
    const staging = join(versionsDir(home), `.${version}.${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    cpSync(ownDir, staging, { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
  }
  writeCurrentVersion(home, version)
  return version
}

const runServer = () => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  // Loading node:sqlite warns that it is experimental; the server runs with that warning off too.
  const emitWarning = process.emitWarning.bind(process)
  process.emitWarning = () => {}
  try {
    lockServerHome(home)
  } catch (error) {
    if (!(error instanceof ServerDbLockedError)) throw error
    throw new Error(
      `Another strategies server runs from ${home}: stop it first, or set STRATEGIES_SERVER_HOME to another directory`,
    )
  } finally {
    process.emitWarning = emitWarning
  }
  let child: ChildProcess | null = null
  const maxMb = readIntEnv(
    SERVER_LOGS_MAX_MB_ENV,
    MIN_SERVER_LOGS_MAX_MB,
    MAX_SERVER_LOGS_MAX_MB,
    DEFAULT_SERVER_LOGS_MAX_MB,
  )
  const writer = createServerLogWriter({
    dir: serverLogsDir(home),
    maxBytes: serverLogsMaxBytes(maxMb),
    now: () => Date.now(),
    onError: (error) =>
      process.stderr.write(
        `strategies server logs cannot be written: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
  })
  logWriter = writer
  process.on('uncaughtExceptionMonitor', (error) => {
    logWriter?.write('launcher', 'err', `${error.stack ?? String(error)}\n`)
  })
  process.on('exit', () => logWriter?.close())
  // The terminal or service may close them, the log keeps every line regardless.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})

  const installedVersion = readCurrentVersion(home)
  if (installedVersion !== null && !asService && installedVersion !== ownVersion()) {
    log(
      `WARNING: strategies server running is still using version ${installedVersion}, update through web UI`,
    )
  }

  const launcher = runLauncher({
    readCurrentVersion: () => readCurrentVersion(home) ?? installOwnVersion(),
    writeCurrentVersion: (version) => writeCurrentVersion(home, version),
    readLastReadyVersion: () => readLastReadyVersion(home),
    writeLastReadyVersion: (version) => writeLastReadyVersion(home, version),
    spawnServer: (version, { onReady, onExit }) => {
      log(`starting strategies server ${version}`)
      const server = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', join(versionDir(home, version), SERVER_ENTRY)],
        {
          stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            STRATEGIES_STORE_DIR: storeDir,
            STRATEGIES_SERVER_HOME: home,
            STRATEGIES_SERVER_VERSION: version,
          },
        },
      )
      child = server
      server.stdout?.on(
        'data',
        createServerOutputTee({
          asService,
          writer,
          stream: 'out',
          output: process.stdout,
          logsDir: serverLogsDir(home),
        }),
      )
      server.stderr?.on(
        'data',
        createServerOutputTee({
          asService,
          writer,
          stream: 'err',
          output: process.stderr,
          logsDir: serverLogsDir(home),
        }),
      )
      server.on('message', (message) => {
        if ((message as { kind?: unknown } | null)?.kind === 'ready') onReady()
      })
      server.once('exit', (code) => {
        let reported = false
        const report = () => {
          if (reported) return
          reported = true
          clearTimeout(drainTimer)
          writer.flush('server')
          if (child === server) child = null
          onExit(code)
        }
        // Its last output can still be in the pipes, and a worker it left behind holds them open.
        const drainTimer = setTimeout(report, SERVER_OUTPUT_DRAIN_MS)
        server.once('close', report)
      })
      return () => server.kill('SIGTERM')
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout | undefined),
    exit: (code) => process.exit(code),
    log,
    now: () => Date.now(),
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      launcher.stop()
      if (child) child.kill(signal)
      else process.exit(0)
    })
  }
}

const command = process.argv[2]
const runCommand = async () => {
  if (command === undefined) {
    checkStoreDir(storeDir, [process.cwd(), home])
    runServer()
  } else if (command === 'install-service') {
    const homeEnv = join(home, '.env')
    // Without a .env here, installService reinstalls with the one in home.
    if (!existsSync('.env') && existsSync(homeEnv)) process.loadEnvFile(homeEnv)
    const tls = await readTlsSettings()
    const allowedAccountIndex = readAllowedAccountIndex(tls !== null)
    readWsPort(tls?.httpPort ?? null)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    log(`installing strategies server ${readCurrentVersion(home) ?? installOwnVersion()}`)
    if (tls) await ensureTlsCertificate({ home, ...tls, log })
    installService({
      home,
      node: process.execPath,
      ownLauncher: ownFile,
      envFile: resolve('.env'),
      allowedAccountIndex,
      log,
    })
  } else if (command === 'uninstall-service') {
    const flags = process.argv.slice(3)
    const unknown = flags.find((flag) => flag !== DELETE_RUNNING_STRATEGIES_FLAG)
    if (unknown !== undefined) {
      throw new Error(
        `unknown option ${unknown}, uninstall-service only accepts ${DELETE_RUNNING_STRATEGIES_FLAG}`,
      )
    }
    uninstallService({
      home,
      log,
      deleteRunningStrategies: flags.includes(DELETE_RUNNING_STRATEGIES_FLAG),
    })
  } else {
    log(`unknown command ${command}, expected install-service or uninstall-service`)
    process.exitCode = 1
  }
}
runCommand().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
