export interface EnvRegistry {
  local: true
  staging: true
  testnet: true
  mainnet: true
  'robinhood-testnet': true
  'robinhood-mainnet': true
}

export type Env = keyof EnvRegistry

export const currentEnv: { env: Env } = { env: null! }

const isRobinhoodEnvValue = (env: Env) => env === 'robinhood-testnet' || env === 'robinhood-mainnet'

const isMainnetEnvValue = (env: Env) => env === 'mainnet' || env?.endsWith('-mainnet') === true

export const isRobinhoodEnv = () => isRobinhoodEnvValue(currentEnv.env)

export const isMainnetEnv = () => isMainnetEnvValue(currentEnv.env)

export const isStagingEnv = () => currentEnv.env === 'staging'

export const shouldUseECDSA = () => false

export const isRobinhoodLimits = () => isRobinhoodEnv()

export const isRobinhoodFeeTiers = () => isRobinhoodEnv()

export const isLivePointsEnabled = () => isRobinhoodEnv()

export const isRobinhoodCopy = () => isRobinhoodEnv()

export const isExcludedAssetsFilterEnabled = () => !isRobinhoodEnv()

export const isGeoBlockEnabled = () => isMainnetEnv()

export const isTokenListFallbackMerged = () => !isMainnetEnv()

export const isStagingAnnouncements = () => isStagingEnv()

export const getRelayDepository = () =>
  isRobinhoodEnv()
    ? ({ chainId: 'robinhood-lighter', accountIndex: 33627 } as const)
    : ({ chainId: 'lighter', accountIndex: 731033 } as const)

const INSTANCE_KEY_ALIASES: Record<string, string> = { robinhood: 'rh' }

/** Prefix of the locize keys an instance overrides, from the env name: `rh_` for `robinhood-*`. */
export const instanceKeyPrefixOf = (env: Env) => {
  const instance = /^(.+)-(mainnet|testnet)$/.exec(env ?? '')?.[1]
  return instance ? `${INSTANCE_KEY_ALIASES[instance] ?? instance}_` : ''
}

/**
 * Locize keys of the maintenance timer and the maintenance page body. Instances share one timer
 * across their mainnet and testnet; every non-mainnet env shows the page on `test_maintenance_scheduled_body`.
 * Takes the env explicitly for the strategies server, which reads them before initCommonPackage.
 */
export const getMaintenanceKeysOf = (env: Env): { timer: string; body: string } => {
  const instancePrefix = instanceKeyPrefixOf(env)
  const isMainnet = isMainnetEnvValue(env)
  const lighterTimer = isMainnet ? 'maintenance_timer' : 'test_maintenance_timer'
  return {
    timer: instancePrefix ? `${instancePrefix}maintenance_timer` : lighterTimer,
    body: `${isMainnet ? instancePrefix : 'test_'}maintenance_scheduled_body`,
  }
}
