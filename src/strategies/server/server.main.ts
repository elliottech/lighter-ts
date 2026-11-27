// Node entry of the strategies server: holds the store dir's lock and the
// signer (server.lock.db), serves frontends over a websocket and runs the
// strategy engines in a worker process (server.worker.ts) it spawns.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { Clock } from '../engine/types'
import { STRATEGY_STORE_KEY } from '../store/strategyStorage'
import { captureWorkerException, configureWorkerExceptions } from '../worker/captureWorkerException'
import type { WorkerToMain } from '../worker/protocol'
import { fetchApiKeyPublicKey } from './backendApiKey'
import { readPersistedStrategies } from './fileStrategyStorage'
import {
  checkRegisteredAccountIndex,
  readAllowedAccountIndex,
  readAllowedApiKeyIndexes,
  readMaxStrategyNotional,
  readStoreDir,
  readStrategyWorkerConfig,
  readUpdatePolicy,
  readWsPort,
} from './serverConfig'
import { openServerDb } from './serverDb'
import {
  DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
  DEFAULT_MAX_ERROR_STACK_LENGTH,
  createServerErrors,
} from './serverErrors'
import { openServerLogs, serverLogsDir } from './serverLogs'
import { initServerWasm, shouldReportSignerError, verifyServerCommandSignature } from './serverWasm'
import { readEnv, readIntEnv, readOneOfEnv, readOriginsEnv, readUrlEnv } from './serverEnv'
import { STRATEGIES_SERVER_RESTART_EXIT_CODE } from './serverHome'
import { MAX_API_KEY_INDEX, parseServerInput } from './serverInput'
import type { WorkerToServer } from './serverProtocol'
import { PRIVILEGED_PORTS_HINT } from './serverAcme'
import {
  TLS_RENEWAL_CHECK_MS,
  ensureTlsCertificate,
  readTlsCertificate,
  readTlsSettings,
  readServableTlsCertificate,
} from './serverTls'
import { installServerVersion, refuseUpdate } from './serverUpdate'
import { MAINTENANCE_SCHEDULE_URL, fetchMaintenanceSchedule } from './maintenanceSchedule'
import { STRATEGIES_WS_UPDATE_DOWNTIME_ERROR, createPlatformMonitor } from './platformMonitor'
import { fetchServerTimeOffset, probePlatform } from './platformProbe'
import { type UpdateResult, createStrategiesWsServer } from './strategiesWsServer'
import {
  DEFAULT_STRATEGIES_API_KEY_INDEX,
  type WorkerProcess,
  createWorkerSupervisor,
  endWorkerProcess,
} from './workerSupervisor'

const MAX_CHAIN_ID = 2 ** 32 - 1
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'server.worker.mjs')

const serializeError = (_key: string, value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value

process.stdout.on('error', (error) => {
  console.error('strategies server stdout failed:', error.message)
})
// Both are pipes to the launcher, which can die first.
process.stderr.on('error', () => {})

const writeLine = (message: WorkerToMain): void => {
  if (!process.stdout.writable) return
  process.stdout.write(`${JSON.stringify(message, serializeError)}\n`)
}

configureWorkerExceptions(writeLine)
// Node exits on an unhandled rejection, and the worker exits with its stdin.
process.on('unhandledRejection', (reason) => {
  captureWorkerException(reason, { tags: { feature: 'strategies-server-unhandled-rejection' } })
})

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
}

// Both set by the launcher (launcher.ts), which also holds the IPC channel.
const serverHome = readEnv('STRATEGIES_SERVER_HOME')
const serverVersion = readEnv('STRATEGIES_SERVER_VERSION') ?? null
process.stderr.write(
  `strategies server version ${serverVersion ?? 'unknown (not started by the launcher)'}\n`,
)

const db = openServerDb(readStoreDir())
const serverErrors = createServerErrors({
  db,
  clock,
  version: serverVersion,
  maxMessageLength: readIntEnv(
    'STRATEGIES_SERVER_MAX_ERROR_MESSAGE_LENGTH',
    1,
    1_000_000,
    DEFAULT_MAX_ERROR_MESSAGE_LENGTH,
  ),
  maxStackLength: readIntEnv(
    'STRATEGIES_SERVER_MAX_ERROR_STACK_LENGTH',
    1,
    1_000_000,
    DEFAULT_MAX_ERROR_STACK_LENGTH,
  ),
  onStoreError: (error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`strategies server could not store an error: ${message}\n`)
  },
})
const writeOutput = (message: WorkerToMain): void => {
  serverErrors.record(message)
  writeLine(message)
}
configureWorkerExceptions(writeOutput)
const strategyWorkerConfig = readStrategyWorkerConfig()
// Read by the worker; checked here so a bad value fails startup, not every worker spawn.
readMaxStrategyNotional()
const chainId = readIntEnv('LIGHTER_CHAIN_ID', 1, MAX_CHAIN_ID)
const isPoolAccount = readOneOfEnv('LIGHTER_IS_POOL_ACCOUNT', ['true', 'false'], 'false') === 'true'
const apiKeyIndex = readIntEnv(
  'STRATEGIES_API_KEY_INDEX',
  0,
  MAX_API_KEY_INDEX,
  DEFAULT_STRATEGIES_API_KEY_INDEX,
)
const tlsSettings = await readTlsSettings()
const wsHost = readEnv('STRATEGIES_WS_HOST') ?? (tlsSettings ? '0.0.0.0' : '127.0.0.1')
const wsPort = readWsPort(tlsSettings?.httpPort ?? null)
const wsAllowedApiKeyIndexes = readAllowedApiKeyIndexes()
const wsAllowedAccountIndex = readAllowedAccountIndex(tlsSettings !== null)
checkRegisteredAccountIndex(
  wsAllowedAccountIndex,
  db.readSigner()?.accountIndex ?? db.readPendingSigner()?.accountIndex ?? null,
)
const updatePolicy = readUpdatePolicy()
const wsAllowedOrigins = readOriginsEnv('STRATEGIES_WS_ALLOWED_ORIGINS', [
  'https://app.lighter.xyz',
])
const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.')

const maintenanceScheduleUrl = readUrlEnv(
  'STRATEGIES_MAINTENANCE_SCHEDULE_URL',
  ['https:', 'http:'],
  MAINTENANCE_SCHEDULE_URL,
)

const registry = {
  url: readUrlEnv('STRATEGIES_SERVER_REGISTRY', ['https:', 'http:'], 'https://registry.npmjs.org'),
  packageName: readEnv('STRATEGIES_SERVER_PACKAGE') ?? 'lighter-ts',
}
const registryUrl = new URL(registry.url)
if (registryUrl.protocol === 'http:' && !isLoopbackHost(registryUrl.hostname)) {
  throw new Error(
    `STRATEGIES_SERVER_REGISTRY must use https: unless it is on this machine, got "${registry.url}"`,
  )
}
if (tlsSettings && !serverHome) {
  throw new Error('STRATEGIES_TLS_IP needs STRATEGIES_SERVER_HOME, where the certificate is kept')
}
const renewTlsCertificate = async (settings = tlsSettings) => {
  if (!settings || !serverHome) return null
  return ensureTlsCertificate({
    home: serverHome,
    ...settings,
    log: (message) => process.stderr.write(`${message}\n`),
  })
}
let tlsCertificate = null
if (tlsSettings && serverHome) {
  // Let's Encrypt can take minutes: a certificate not expired yet serves until the renewal check below replaces it.
  tlsCertificate = readServableTlsCertificate(serverHome, tlsSettings.directoryUrl, Date.now())
  tlsCertificate ??= await renewTlsCertificate().catch((error: unknown) => {
    if (!readTlsCertificate(serverHome)) throw error
    captureWorkerException(error, { tags: { feature: 'strategies-server-tls' } })
    return null
  })
  tlsCertificate ??= readTlsCertificate(serverHome)
}
if (!tlsCertificate && !isLoopbackHost(wsHost)) {
  process.stderr.write(
    `WARNING: STRATEGIES_WS_HOST=${wsHost} is reachable from other machines and the websocket has no TLS: ` +
      'every command and every update crosses the network in clear text. ' +
      'Bind to 127.0.0.1, or set STRATEGIES_TLS_IP to serve it over wss://.\n',
  )
}
if (wsAllowedAccountIndex === null && !isLoopbackHost(wsHost)) {
  process.stderr.write(
    `WARNING: STRATEGIES_WS_HOST=${wsHost} is reachable from other machines and any Lighter account may sign in: ` +
      'until yours does, someone else can claim the server. ' +
      'Set STRATEGIES_WS_ALLOWED_ACCOUNT_INDEX to your account index.\n',
  )
}

const report = (feature: string) => (error: unknown) =>
  captureWorkerException(error, { tags: { feature } })

const reportOnce = (feature: string) => (error: unknown) => {
  if (shouldReportSignerError(error)) report(feature)(error)
}

const spawnWorker = ({
  onMessage,
  onExit,
}: {
  onMessage: (message: WorkerToServer) => void
  onExit: (code: number | null) => void
}): WorkerProcess => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', WORKER_PATH], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      resolve()
      onExit(code)
    })
  })
  child.on('error', report('strategies-server-worker'))
  child.stdin.on('error', report('strategies-server-worker'))
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return
    let message: WorkerToServer
    try {
      message = JSON.parse(line) as WorkerToServer
    } catch {
      process.stderr.write(`${line}\n`)
      return
    }
    onMessage(message)
  })
  return {
    send: (message) => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    kill: () => endWorkerProcess(child, exited, clock),
  }
}

const readStrategiesOnDisk = () => {
  try {
    return readPersistedStrategies(readStoreDir(), STRATEGY_STORE_KEY)
  } catch (error) {
    report('strategies-server-store')(error)
    return {}
  }
}

const getPublicKey = (accountIndex: number, apiKeyIndex: number) =>
  fetchApiKeyPublicKey(strategyWorkerConfig, accountIndex, apiKeyIndex)

const supervisor = createWorkerSupervisor({
  db,
  chainId,
  apiKeyIndex,
  isPoolAccount,
  clock,
  persistedStrategies: readStrategiesOnDisk(),
  // The platform monitor resumes it once the first check finds no maintenance.
  startPaused: true,
  spawnWorker,
  getPublicKey,
  onWorkerMessage: writeOutput,
  onError: report('strategies-server-worker'),
})

const platformMonitor = createPlatformMonitor({
  clock,
  random: Math.random,
  fetchSchedule: () => fetchMaintenanceSchedule(maintenanceScheduleUrl, strategyWorkerConfig.env),
  fetchServerTimeOffset: () => fetchServerTimeOffset(strategyWorkerConfig),
  probe: () => probePlatform(strategyWorkerConfig),
  pause: supervisor.pause,
  resume: supervisor.resume,
  onError: report('strategies-server-platform'),
})
platformMonitor.subscribePlatform(({ status, maintenanceAt }) => {
  const at =
    maintenanceAt === null ? '' : ` (maintenance at ${new Date(maintenanceAt).toISOString()})`
  process.stderr.write(`strategies server platform ${status}${at}\n`)
})

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  try {
    const command = parseServerInput(line)
    if (command.kind === 'update') {
      throw new Error('update is only accepted from a websocket client')
    }
    const answer = (result: boolean | string) => {
      if (result === false) {
        throw new Error('The strategies server has no signer yet, register its key from a frontend')
      }
      if (typeof result === 'string') throw new Error(result)
    }
    void supervisor.send(command).then(answer).catch(report('strategies-server-input'))
  } catch (error) {
    report('strategies-server-input')(error)
  }
})

let updating = false

const restart = async (version: string) => {
  process.stderr.write(`strategies server restarting on ${version}\n`)
  platformMonitor.close()
  await Promise.allSettled([wsServer.close(), supervisor.close()])
  process.exit(STRATEGIES_SERVER_RESTART_EXIT_CODE)
}

// The launcher died: exit too, or this server keeps the store lock and the
// one the service starts next cannot open it.
process.on('disconnect', () => {
  process.stderr.write('strategies server lost its launcher, exiting\n')
  platformMonitor.close()
  void Promise.allSettled([wsServer.close(), supervisor.close()]).then(() => process.exit(1))
})

const update = async (version: string): Promise<UpdateResult> => {
  if (!serverHome || !serverVersion || !process.send) {
    return {
      ok: false,
      error: 'Only a server started by the strategies-server launcher can update',
    }
  }
  if (version === serverVersion) return { ok: false, error: `The server already runs ${version}` }
  const refused = refuseUpdate(serverVersion, version, updatePolicy)
  if (refused) return { ok: false, error: refused }
  if (updating) return { ok: false, error: 'An update is already in progress' }
  if (!platformMonitor.allowsUpdate())
    return { ok: false, error: STRATEGIES_WS_UPDATE_DOWNTIME_ERROR }
  updating = true
  try {
    await installServerVersion({ home: serverHome, version, registry })
  } catch (error) {
    updating = false
    report('strategies-server-update')(error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, restart: () => void restart(version) }
}

// Loaded before the first hello needs it; a failed load is tried again by that hello.
initServerWasm(clock).catch(reportOnce('strategies-server-wasm'))

const wsServer = createStrategiesWsServer({
  host: wsHost,
  port: wsPort,
  allowedOrigins: wsAllowedOrigins,
  clock,
  allowedApiKeyIndexes: wsAllowedApiKeyIndexes,
  allowedAccountIndex: wsAllowedAccountIndex,
  version: serverVersion,
  getPublicKey,
  verifySignature: (publicKey, payload, signature) =>
    verifyServerCommandSignature(clock, publicKey, payload, signature),
  getAccountIndex: supervisor.getAccountIndex,
  getSignerStatus: supervisor.getSignerStatus,
  subscribeSignerStatus: supervisor.subscribeSignerStatus,
  getPlatform: platformMonitor.getPlatform,
  subscribePlatform: platformMonitor.subscribePlatform,
  getRegistration: supervisor.getRegistration,
  subscribeRegistration: supervisor.subscribeRegistration,
  onRegister: supervisor.register,
  onUpdate: update,
  onCommand: supervisor.send,
  getStrategies: supervisor.getStrategies,
  subscribeStrategies: supervisor.subscribeStrategies,
  getErrors: serverErrors.getUnacked,
  subscribeErrors: serverErrors.subscribe,
  onAckErrors: serverErrors.ack,
  openLogs: (size) =>
    serverHome ? openServerLogs(serverLogsDir(serverHome), size) : Promise.resolve(null),
  pingIntervalMs: strategyWorkerConfig.wsPingIntervalMs,
  pongTimeoutMs: strategyWorkerConfig.wsPongTimeoutMs,
  onError: reportOnce('strategies-server-ws'),
  tls: tlsCertificate ?? undefined,
})
if (tlsCertificate) {
  const checkTlsCertificate = () => {
    readTlsSettings()
      .then(renewTlsCertificate)
      .then(
        (renewed) => renewed && wsServer.setCertificate(renewed),
        report('strategies-server-tls'),
      )
  }
  checkTlsCertificate()
  setInterval(checkTlsCertificate, TLS_RENEWAL_CHECK_MS)
}
wsServer.listening.then(
  ({ address, port }) => {
    process.stderr.write(
      `strategies websocket listening on ${tlsCertificate ? 'wss' : 'ws'}://${tlsSettings && tlsCertificate ? tlsSettings.ip : address}:${port}\n`,
    )
    const status = supervisor.getSignerStatus()
    if (status === null || status === 'ready') process.send?.({ kind: 'ready' })
    else {
      const unsubscribe = supervisor.subscribeSignerStatus((next) => {
        if (next !== 'ready') return
        unsubscribe()
        process.send?.({ kind: 'ready' })
      })
    }
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const hint =
      (error as NodeJS.ErrnoException).code === 'EACCES' ? `, ${PRIVILEGED_PORTS_HINT}` : ''
    process.stderr.write(
      `strategies websocket cannot listen on ${wsHost}:${wsPort}: ${message}${hint}\n`,
    )
    process.exit(1)
  },
)
