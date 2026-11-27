import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Refuses a `STRATEGIES_STORE_DIR` that is one of `dirs` or holds one, such as `.`: the store
 * would share it with other files, and uninstall-service deletes the store with all of them.
 */
export const checkStoreDir = (storeDir: string, dirs: string[]): string => {
  for (const dir of dirs) {
    const path = relative(resolve(storeDir), resolve(dir))
    if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) {
      throw new Error(
        `STRATEGIES_STORE_DIR=${storeDir} holds ${resolve(dir)}: set it to a directory of its own, such as store`,
      )
    }
  }
  return storeDir
}

export const readEnv = (name: string): string | undefined => {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

export const readIntEnv = (name: string, min: number, max: number, fallback?: number): number => {
  const raw = readEnv(name)
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`${name} is required`)
    return fallback
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`)
  }
  return value
}

export const readOneOfEnv = <T extends string>(
  name: string,
  values: readonly T[],
  fallback: T,
): T => {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  if (!values.includes(raw as T)) {
    throw new Error(`${name} must be one of ${values.join(', ')}, got "${raw}"`)
  }
  return raw as T
}

export const readUrlEnv = (
  name: string,
  protocols: readonly string[],
  fallback: string,
): string => {
  const raw = readEnv(name) ?? fallback
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be a URL, got "${raw}"`)
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}, got "${raw}"`)
  }
  return raw
}

/** A comma-separated, non-empty list of integers from `min` to `max`. */
export const readIntListEnv = (
  name: string,
  min: number,
  max: number,
  fallback: readonly number[],
): number[] => {
  const raw = readEnv(name)
  if (raw === undefined) return [...fallback]
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length === 0) throw new Error(`${name} must list at least one integer`)
  return entries.map((entry) => {
    const value = /^\d+$/.test(entry) ? Number(entry) : Number.NaN
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must list integers from ${min} to ${max}, got "${entry}"`)
    }
    return value
  })
}

/** A comma-separated list of browser origins, each exactly `scheme://host[:port]`. */
export const readOriginsEnv = (name: string, fallback: readonly string[]): string[] => {
  const raw = readEnv(name)
  if (raw === undefined) return [...fallback]
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      let url: URL | null = null
      try {
        url = new URL(entry)
      } catch {}
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.origin !== entry) {
        throw new Error(`${name} must list origins like https://app.lighter.xyz, got "${entry}"`)
      }
      return entry
    })
}
