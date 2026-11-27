// Worker process of the strategies server (server.main.ts spawns it): the
// message layer between stdin/stdout (newline-delimited JSON, see
// serverProtocol.ts) and StrategyWorker, which hosts the strategy engines.

// Must stay the first import: the strategy store picks its storage on load.
import './useFileStrategyStorage'

import { createInterface } from 'node:readline'
import { Configuration, type Middleware } from 'zklighter-perps'
import type { Clock, StrategyRecord } from '../engine/types'
import {
  Platform,
  apis,
  createApis,
  generateTimestampClientOrderIndex,
  initCommonPackage,
} from '../..'
import { type WasmError, createWasmSigners, getOrCreateAuthToken } from '../../transactions'
import type { MainToWorker } from '../worker/protocol'
import { StrategyWorker } from '../worker/StrategyWorker'
import { captureWorkerException, configureWorkerExceptions } from '../worker/captureWorkerException'
import {
  getWorkerAccountIndex,
  getWorkerApiKeyIndex,
  isSignerKeyRejection,
  isWorkerRegistered,
} from '../worker/workerAuth'
import { readMaxStrategyNotional, readStrategyWorkerConfig } from './serverConfig'
import { parseWorkerInput } from './serverInput'
import type { ServerWorkerAuthMessage, WorkerToServer } from './serverProtocol'
import { useStrategyStore } from '../store/strategyStore'
import { flushStrategyStoreWrites } from '../store/strategyStorage'
import { drainOrderClients } from '../worker/makeOrderClient'
import { getServerWasm, initServerWasm, waitForServerWasm } from './serverWasm'
import { type WorkerRegistrationTarget, signWorkerRegistration } from './workerRegistration'

if (typeof WebSocket === 'undefined') {
  throw new Error(`The strategies server needs Node 22.13 or newer, running ${process.version}`)
}

const notImplemented = (name: string) => (): never => {
  throw new Error(`${name} is not implemented in the strategies server`)
}

const memoryStorage = new Map<string, string>()

const serializeError = (_key: string, value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value

// Without a listener a closed stdout (EPIPE) kills the process, and its strategies with it.
process.stdout.on('error', (error) => {
  console.error('strategies server stdout failed:', error.message)
})

const post = (message: WorkerToServer): void => {
  if (!process.stdout.writable) return
  process.stdout.write(`${JSON.stringify(message, serializeError)}\n`)
}

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle),
}

const strategyWorkerConfig = readStrategyWorkerConfig()
const maxStrategyNotional = readMaxStrategyNotional()

const processServerWasmError = <T extends object>(wasmResponse: T | WasmError): T => {
  if ('error' in wasmResponse) {
    const error = new Error(wasmResponse.error)
    captureWorkerException(error, {
      tags: { feature: 'strategies-server-wasm', error: wasmResponse.error },
    })
    throw error
  }
  return wasmResponse
}

const serverSigners = createWasmSigners({
  getWasm: getServerWasm,
  processWasmCall: async (wasmCall) => (await wasmCall)(),
  processWasmError: processServerWasmError,
  waitForWasm: waitForServerWasm,
})

const SKIPPED_AUTH_PATHS = ['/api/v1/nextNonce', '/api/v1/apikeys']

const authTokenInHeaderMiddleware: Middleware = {
  pre: async ({ url, init }) => {
    const requestUrl = new URL(url)
    if (strategyWorkerConfig.customServer) {
      requestUrl.searchParams.set('server', strategyWorkerConfig.customServer)
    }

    const accountIndex = getWorkerAccountIndex()
    const headers = new Headers(init.headers)
    if (
      accountIndex === null ||
      headers.has('Authorization') ||
      SKIPPED_AUTH_PATHS.includes(requestUrl.pathname)
    )
      return { url: requestUrl.toString(), init }

    const auth = await getOrCreateAuthToken(accountIndex)
    if (!auth) return { url: requestUrl.toString(), init }
    headers.set('PreferAuthServer', 'true')
    headers.set('Authorization', auth.token)
    return { url: requestUrl.toString(), init: { ...init, headers } }
  },
}

let onRequestRejected = (): void => {}

const errorMiddleware: Middleware = {
  post: async ({ response, url }) => {
    if (!response.ok) {
      captureWorkerException(new Error(`Request failed with status ${response.status}`), {
        tags: { feature: 'strategies-server-api', endpoint: new URL(url).pathname },
      })
      if (await isSignerKeyRejection(response)) onRequestRejected()
    }
  },
  onError: ({ error, url }) => {
    captureWorkerException(error, {
      tags: { feature: 'strategies-server-api', endpoint: new URL(url).pathname },
    })
    return Promise.resolve()
  },
}

configureWorkerExceptions(post)
// Node exits on an unhandled rejection; the browser worker only logs it.
process.on('unhandledRejection', (reason) => {
  captureWorkerException(reason, { tags: { feature: 'strategies-server-unhandled-rejection' } })
})
initCommonPackage({
  apiClients: createApis(
    new Configuration({
      basePath: strategyWorkerConfig.restApiBase,
      middleware: [authTokenInHeaderMiddleware, errorMiddleware],
    }),
  ),
  setItem: (key, value) => {
    memoryStorage.set(key, value)
  },
  getItem: (key) => memoryStorage.get(key) ?? null,
  sha256: {
    digest: async (data) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)),
  },
  env: strategyWorkerConfig.env,
  fallbacks: null,
  websocketConfigParam: {
    flushInterval: 250,
    throttleInterval: null,
    accountThrottleInterval: null,
  },
  captureException: captureWorkerException,
  showToastFromError: notImplemented('showToastFromError'),
  signers: serverSigners,
  getApiKeyIndex: getWorkerApiKeyIndex,
  getPlatform: () => Platform.PlatformStrategiesServer,
  generateClientOrderIndex: generateTimestampClientOrderIndex,
  isRegistered: isWorkerRegistered,
  rpcToken: null,
  skipNonce: true,
})

useStrategyStore.subscribe(
  (state) => state.strategies,
  (next: Record<string, StrategyRecord>, previous: Record<string, StrategyRecord>) => {
    const strategies = Object.values(next).filter((record) => previous[record.id] !== record)
    const removed = Object.keys(previous).filter((id) => !(id in next))
    if (strategies.length || removed.length) post({ kind: 'strategies', strategies, removed })
  },
)

const REGISTRATION_RETRY_MS = 5_000
const REGISTRATION_RETRY_MAX_MS = 60_000

let registrationTarget: WorkerRegistrationTarget | null = null
let registering = false
let registrationRetryMs = REGISTRATION_RETRY_MS

// Signs a new key for the frontend to register, as the rejected signer is not retried.
const registerNewKey = () => {
  const target = registrationTarget
  if (!target || registering) return
  registering = true
  signWorkerRegistration(target, {
    signers: serverSigners,
    fetchNonce: (accountIndex, apiKeyIndex) =>
      apis.transactionApi
        .nextNonce({ account_index: accountIndex, api_key_index: apiKeyIndex })
        .then(({ nonce }) => nonce),
  })
    .then(
      (registration) => {
        registrationRetryMs = REGISTRATION_RETRY_MS
        post({ kind: 'registration', registration })
      },
      (error: unknown) => {
        captureWorkerException(error, { tags: { feature: 'strategies-server-registration' } })
        clock.setTimeout(registerNewKey, registrationRetryMs)
        registrationRetryMs = Math.min(registrationRetryMs * 2, REGISTRATION_RETRY_MAX_MS)
      },
    )
    .finally(() => {
      registering = false
    })
}

const signersReady = initServerWasm(clock)
const worker = new StrategyWorker({
  clock,
  post: (message) => {
    // The pending seed is adopted on init; a later rejection registers a new one.
    if (message.kind === 'initialised' && registrationTarget) {
      registrationTarget = { ...registrationTarget, seed: null }
    }
    post(message)
  },
  strategyWorkerConfig,
  signersReady,
  maxStrategyNotional,
  refusePoolAccounts: true,
  onSignerRejected: (error) => {
    post({ kind: 'signerFailed', error })
    void signersReady.then(registerNewKey)
  },
})
// A key revoked mid-run fails sendTx and the reads authenticated with its token.
onRequestRejected = worker.checkSignerKey

worker
  .resumeRunningStrategies()
  .catch((error: unknown) =>
    captureWorkerException(error, { tags: { feature: 'strategies-server-resume' } }),
  )

const dispatch = (msg: MainToWorker | ServerWorkerAuthMessage): void => {
  switch (msg.kind) {
    case 'authenticate':
      registrationTarget = msg.registration
      worker.authenticate(msg)
      break
    case 'start':
      worker.start(msg).catch((error: unknown) =>
        captureWorkerException(error, {
          id: msg.id,
          tags: { feature: 'strategies-server-input' },
        }),
      )
      break
    case 'stop':
      worker.stop(msg)
      break
    case 'remove':
      worker.remove(msg)
      break
    case 'refreshTier':
      void worker.refreshTier()
      break
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return
    let msg: MainToWorker | ServerWorkerAuthMessage
    try {
      msg = parseWorkerInput(line)
    } catch (error) {
      captureWorkerException(error, { tags: { feature: 'strategies-server-input' } })
      return
    }
    dispatch(msg)
  })
  // The server holds the store dir's lock; without it another server could
  // start a second worker on the same store.
  .on('close', () => {
    drainOrderClients()
    void flushStrategyStoreWrites().finally(() => process.exit(0))
  })
