import type { StrategyWorkerConfig } from '../worker/strategyWorkerConfig'

const PROBE_TIMEOUT_MS = 10_000

type BackendConfig = Pick<StrategyWorkerConfig, 'restApiBase' | 'customServer'>

const get = async (
  config: BackendConfig,
  path: string,
  params: Record<string, string | number> = {},
): Promise<Record<string, unknown>> => {
  const url = new URL(path, config.restApiBase)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  if (config.customServer) url.searchParams.set('server', config.customServer)
  const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`GET ${path} failed with HTTP ${response.status}`)
  const body = (await response.json()) as Record<string, unknown>
  if (body.code !== undefined && body.code !== 200) {
    throw new Error(`GET ${path} failed with code ${JSON.stringify(body.code)}`)
  }
  return body
}

/**
 * The backend's clock minus this machine's, in ms. `GET /` answers whenever
 * the API process runs, so it tells the time but not whether the venue is up.
 */
export const fetchServerTimeOffset = async (config: BackendConfig): Promise<number> => {
  const sentAt = Date.now()
  const { timestamp } = await get(config, '/')
  if (typeof timestamp !== 'number') throw new Error('GET / has no timestamp')
  return timestamp * 1000 - (sentAt + Date.now()) / 2
}

/**
 * Resolves once the API server has caught up with the committer, which is when
 * `ws_status` answers code 200. Rejects otherwise.
 */
export const probePlatform = async (config: BackendConfig): Promise<void> => {
  await get(config, '/api/v1/ws_status')
}
