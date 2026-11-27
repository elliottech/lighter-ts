import type { Env } from '../..'
import { API_KEY_INDEXES } from '../../utils/common'
import type { StrategyWorkerConfig } from '../worker/strategyWorkerConfig'
import {
  checkStoreDir,
  readEnv,
  readIntEnv,
  readIntListEnv,
  readOneOfEnv,
  readUrlEnv,
} from './serverEnv'
import { MAX_API_KEY_INDEX } from './serverInput'
import type { UpdatePolicy } from './serverUpdate'

const ENVS = [
  'testnet',
  'mainnet',
  'robinhood-testnet',
  'robinhood-mainnet',
] as const satisfies readonly Env[]

const API_BASES: Record<(typeof ENVS)[number], { rest: string; ws: string }> = {
  testnet: {
    rest: 'https://api.testnet.lighter.xyz',
    ws: 'wss://api.testnet.lighter.xyz/stream',
  },
  mainnet: {
    rest: 'https://mainnet.zklighter.elliot.ai',
    ws: 'wss://mainnet.zklighter.elliot.ai/stream',
  },
  'robinhood-testnet': {
    rest: 'https://api.rh-testnet.lighter.xyz',
    ws: 'wss://api.rh-testnet.lighter.xyz/stream',
  },
  'robinhood-mainnet': {
    rest: 'https://api.rh.lighter.xyz',
    ws: 'wss://api.rh.lighter.xyz/stream',
  },
}

export const readStrategyWorkerConfig = (): StrategyWorkerConfig => {
  const env = readOneOfEnv('LIGHTER_ENV', ENVS, 'mainnet')
  return {
    customServer: readEnv('LIGHTER_CUSTOM_SERVER') ?? null,
    encoding: readOneOfEnv('LIGHTER_WS_ENCODING', ['msgpack', 'json'], 'msgpack'),
    env,
    restApiBase: readUrlEnv('LIGHTER_REST_API_BASE', ['https:', 'http:'], API_BASES[env].rest),
    wsApiBase: readUrlEnv('LIGHTER_WS_API_BASE', ['wss:', 'ws:'], API_BASES[env].ws),
    wsPingIntervalMs: 2500,
    wsPongTimeoutMs: 12000,
  }
}

export const readStoreDir = (): string =>
  checkStoreDir(readEnv('STRATEGIES_STORE_DIR') ?? '.strategies-store', [process.cwd()])

export const DEFAULT_MAX_STRATEGY_NOTIONAL = 1_000_000

export const readMaxStrategyNotional = (): number =>
  readIntEnv('STRATEGIES_MAX_NOTIONAL', 1, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_STRATEGY_NOTIONAL)

/** The app API keys a client may sign with; the server's own key is not one of them. */
export const DEFAULT_ALLOWED_API_KEY_INDEXES: readonly number[] = [
  API_KEY_INDEXES.DESKTOP,
  API_KEY_INDEXES.QR,
  API_KEY_INDEXES.MOBILE_BROWSER,
  API_KEY_INDEXES.MOBILE_APP,
]

export const readAllowedApiKeyIndexes = (): number[] =>
  readIntListEnv(
    'STRATEGIES_WS_ALLOWED_API_KEY_INDEXES',
    0,
    MAX_API_KEY_INDEX,
    DEFAULT_ALLOWED_API_KEY_INDEXES,
  )

const ALLOWED_ACCOUNT_INDEX_ENV = 'STRATEGIES_WS_ALLOWED_ACCOUNT_INDEX'

/** The only account a frontend may sign in with, null for any; required with STRATEGIES_TLS_IP. */
export const readAllowedAccountIndex = (required: boolean): number | null => {
  const value = readEnv(ALLOWED_ACCOUNT_INDEX_ENV)
  if (value === 'any') return null
  if (value === undefined) {
    if (!required) return null
    throw new Error(
      `${ALLOWED_ACCOUNT_INDEX_ENV} is required with STRATEGIES_TLS_IP: set it to your account index, or to any to let the first account that signs in claim the server`,
    )
  }
  return readIntEnv(ALLOWED_ACCOUNT_INDEX_ENV, 0, Number.MAX_SAFE_INTEGER)
}

/** Refuses a store registered to another account: its strategies would run with no frontend allowed in. */
export const checkRegisteredAccountIndex = (allowed: number | null, registered: number | null) => {
  if (allowed === null || registered === null || registered === allowed) return
  throw new Error(
    `${ALLOWED_ACCOUNT_INDEX_ENV}=${allowed} but the store is registered to account ${registered}: set it to ${registered}, or run uninstall-service --delete-running-strategies to delete the store`,
  )
}

/** The websocket port, refused when it is the ACME http-01 port: the challenge listener could not bind it to renew. */
export const readWsPort = (acmeHttpPort: number | null): number => {
  const port = readIntEnv('STRATEGIES_WS_PORT', 1, 65535, acmeHttpPort === null ? 8787 : 443)
  if (port === acmeHttpPort) {
    throw new Error(
      `STRATEGIES_WS_PORT and STRATEGIES_ACME_HTTP_PORT are both ${port}: the certificate cannot be renewed while the websocket holds that port, so give them different ports`,
    )
  }
  return port
}

const readBooleanEnv = (name: string): boolean =>
  readOneOfEnv(name, ['true', 'false'], 'false') === 'true'

export const readUpdatePolicy = (): UpdatePolicy => ({
  allowPrerelease: readBooleanEnv('STRATEGIES_ALLOW_PRERELEASE_UPDATES'),
  allowDowngrade: readBooleanEnv('STRATEGIES_ALLOW_DOWNGRADE'),
})
