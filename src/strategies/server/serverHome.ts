import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isServerVersion } from './serverInput'

/** The server exits with it once a new version is installed; the launcher then starts that version. */
export const STRATEGIES_SERVER_RESTART_EXIT_CODE = 75
export const SERVER_ENTRY = 'server.main.mjs'

export const versionsDir = (home: string): string => join(home, 'versions')
export const versionDir = (home: string, version: string): string =>
  join(versionsDir(home), version)

const CURRENT_FILE = 'current'
const LAST_READY_FILE = 'last-ready'
/** The files that name the installed versions, which uninstall-service deletes. */
export const VERSION_FILES = [CURRENT_FILE, LAST_READY_FILE]

const readVersionFile = (home: string, file: string): string | null => {
  let version: string
  try {
    version = readFileSync(join(home, file), 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!isServerVersion(version)) return null
  return existsSync(join(versionDir(home, version), SERVER_ENTRY)) ? version : null
}

const writeVersionFile = (home: string, file: string, version: string): void => {
  const path = join(home, file)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${version}\n`)
  renameSync(temporary, path)
}

/** The installed version the launcher runs, null when there is none. */
export const readCurrentVersion = (home: string): string | null =>
  readVersionFile(home, CURRENT_FILE)
export const writeCurrentVersion = (home: string, version: string): void =>
  writeVersionFile(home, CURRENT_FILE, version)

/** The last installed version that got ready, which a launcher started after an update goes back to. */
export const readLastReadyVersion = (home: string): string | null =>
  readVersionFile(home, LAST_READY_FILE)
export const writeLastReadyVersion = (home: string, version: string): void =>
  writeVersionFile(home, LAST_READY_FILE, version)
