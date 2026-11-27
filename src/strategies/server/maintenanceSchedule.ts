import type { Env } from '../..'
import { getMaintenanceKeysOf } from '../../lib/env'

const FETCH_TIMEOUT_MS = 10_000

/** The settings namespace the frontends read their maintenance banner and page from. */
export const MAINTENANCE_SCHEDULE_URL = 'https://assets.lighter.xyz/fe/locales/en/settings.json'

export interface MaintenanceSchedule {
  /** Epoch ms the announced downtime starts at, null when none is announced. */
  startsAt: number | null
  /** The frontends show the maintenance page. */
  inProgress: boolean
}

const stringOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export const parseMaintenanceSchedule = (
  settings: Record<string, unknown>,
  env: Env,
): MaintenanceSchedule => {
  const keys = getMaintenanceKeysOf(env)
  const timer = stringOf(settings[keys.timer])
  const startsAt = timer ? new Date(timer).getTime() : Number.NaN
  return {
    startsAt: Number.isFinite(startsAt) ? startsAt : null,
    inProgress: stringOf(settings[keys.body]) !== '',
  }
}

export const fetchMaintenanceSchedule = async (
  url: string,
  env: Env,
): Promise<MaintenanceSchedule> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`Fetching the maintenance schedule failed with HTTP ${response.status}`)
  }
  const settings: unknown = await response.json()
  if (typeof settings !== 'object' || settings === null) {
    throw new Error('The maintenance schedule is not an object')
  }
  return parseMaintenanceSchedule(settings as Record<string, unknown>, env)
}
