import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StrategyRecord } from '../engine/types'
import type { StrategyStorageValue } from '../store/strategyStorage'

export const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export const strategyFileOf = (dir: string, name: string) =>
  join(dir, `${encodeURIComponent(name)}.json`)

/** The records last written under `name`, none when nothing was written. */
export const readPersistedStrategies = (
  dir: string,
  name: string,
): Record<string, StrategyRecord> => {
  try {
    const value = JSON.parse(
      readFileSync(strategyFileOf(dir, name), 'utf8'),
    ) as StrategyStorageValue
    return value.state?.strategies ?? {}
  } catch (error) {
    if (isMissing(error)) return {}
    throw error
  }
}
