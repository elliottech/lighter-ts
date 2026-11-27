import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import {
  type StrategyStorageBackend,
  type StrategyStorageValue,
  isNewerStrategyStoreVersion,
} from '../store/strategyStorage'
import { isMissing, strategyFileOf } from './persistedStrategies'

export { readPersistedStrategies } from './persistedStrategies'

const syncPath = async (path: string, flags: string) => {
  const handle = await open(path, flags)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Keeps each store name in `<dir>/<name>.json`. A write goes to a temporary
 * file that is synced and renamed over the old one, so a crash leaves either
 * the previous or the new contents, never a partial file.
 */
export const createFileStrategyStorageBackend = (dir: string): StrategyStorageBackend => {
  const read = async (name: string): Promise<StrategyStorageValue | null> => {
    try {
      return JSON.parse(await readFile(strategyFileOf(dir, name), 'utf8')) as StrategyStorageValue
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }
  return {
    read,
    write: async (name, value) => {
      if (isNewerStrategyStoreVersion(await read(name), value)) return false
      await mkdir(dir, { recursive: true })
      const file = strategyFileOf(dir, name)
      const temporary = `${file}.tmp`
      const handle = await open(temporary, 'w')
      try {
        await handle.writeFile(JSON.stringify(value))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, file)
      await syncPath(dir, 'r')
      return true
    },
    remove: async (name) => {
      try {
        await unlink(strategyFileOf(dir, name))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    },
  }
}
