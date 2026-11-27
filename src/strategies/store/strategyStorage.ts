import type { StrategyRecord } from '../engine/types'
import { errorReporting, wait } from '../..'
import type { PersistStorage, StorageValue } from 'zustand/middleware'

export { STRATEGY_STORE_KEY } from './strategyStoreKey'

const DATABASE = 'lighter-strategies'
const STORE = 'store'
const CHANNEL_NAME = 'lighter-strategy-store'
const READ_ATTEMPTS = 2
const READ_RETRY_DELAY_MS = 500

type PersistedStrategies = { strategies: Record<string, StrategyRecord> }
type Value = StorageValue<PersistedStrategies>
export type StrategyStorageValue = Value
type WrittenMessage = { type: 'written'; name: string }

/** Where the strategy store keeps its records. */
export interface StrategyStorageBackend {
  read: (name: string) => Promise<Value | null>
  /** Writes `value` unless the stored one has a newer version; resolves to whether it wrote. */
  write: (name: string, value: Value) => Promise<boolean>
  remove: (name: string) => Promise<void>
}

export const isNewerStrategyStoreVersion = (stored: Value | null | undefined, value: Value) =>
  (stored?.version ?? 0) > (value.version ?? 0)

let configuredBackend: StrategyStorageBackend | null = null

let database: Promise<IDBDatabase> | null = null
let channel: BroadcastChannel | null = null
const writtenListeners = new Set<(name: string) => void>()
const readNames = new Set<string>()
const reported = new Set<string>()
const pendingWrites = new Set<Promise<boolean>>()
let latestWrite: Promise<boolean> = Promise.resolve(true)
const writeQueues = new Map<string, Promise<void>>()

/**
 * Set when the persisted store was written by a newer app version. This tab
 * cannot read it, so it must not write over it either.
 */
export const strategyStoreVersion = {
  isOutdated: false,
}

const report = (feature: string, error: unknown) => {
  if (reported.has(feature)) return
  reported.add(feature)
  errorReporting.captureException(error, { tags: { feature } })
}

// Safari can abort a transaction with neither the transaction nor the
// request carrying an error.
const transactionError = (tx: IDBTransaction, request: IDBRequest) =>
  tx.error ?? request.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError')

const openDatabase = (): Promise<IDBDatabase> => {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        database = null
      }
      db.onclose = () => {
        database = null
      }
      resolve(db)
    }
  }).catch((error: unknown) => {
    // Safari and WebViews lose the connection to the IndexedDB server
    // transiently, so the next operation opens again.
    database = null
    throw error
  })
  return database
}

// Two operations failing together both reconnect; the second must not drop
// the connection the first one's retry already opened.
const reconnect = async () => {
  const current = database
  const db = await current?.catch(() => null)
  db?.close()
  if (database === current) database = null
}

// Safari closes a backgrounded page's connection without firing `close`, so
// the cached connection only turns out dead when the next transaction opens
// (`InvalidStateError`) or aborts, sometimes without an error. Every
// operation therefore gets one retry on a fresh connection.
const transact = async <T>(
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
  retry = true,
): Promise<T> => {
  try {
    const db = await openDatabase()
    return await body(db.transaction(STORE, mode))
  } catch (error) {
    if (!retry) throw error
    await reconnect()
    return transact(mode, body, false)
  }
}

const run = <T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  transact(
    mode,
    (tx) =>
      new Promise<T>((resolve, reject) => {
        const request = action(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(request.result)
        tx.onabort = tx.onerror = () => reject(transactionError(tx, request))
      }),
  )

const noop = () => undefined

// Writes to a name run one at a time, so a write retried after an abort
// still commits before the newer ones.
const runWrite = <T>(name: string, action: () => Promise<T>): Promise<T> => {
  const write = (writeQueues.get(name) ?? Promise.resolve()).then(action)
  const settled = write.then(noop, noop)
  writeQueues.set(name, settled)
  void settled.then(() => {
    if (writeQueues.get(name) === settled) writeQueues.delete(name)
  })
  return write
}

const ensureChannel = (): BroadcastChannel | null => {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.onmessage = (event: MessageEvent<WrittenMessage>) => {
    if (event.data?.type !== 'written') return
    for (const listener of writtenListeners) listener(event.data.name)
  }
  return channel
}

const notifyWritten = (name: string) => {
  ensureChannel()?.postMessage({
    type: 'written',
    name,
  } satisfies WrittenMessage)
}

const indexedDbBackend: StrategyStorageBackend = {
  read: async (name) =>
    ((await run('readonly', (store) => store.get(name))) as Value | undefined) ?? null,
  write: async (name, value) => {
    // A put throwing inside `onsuccess` only surfaces as the abort.
    let putError: unknown
    try {
      // Read in the write's transaction: another tab may have written a newer
      // version after this one loaded.
      const stored = await run('readwrite', (store) => {
        const request = store.get(name) as IDBRequest<Value | undefined>
        request.onsuccess = () => {
          if (isNewerStrategyStoreVersion(request.result, value)) return
          try {
            store.put(value, name)
          } catch (error) {
            putError = error
            store.transaction.abort()
          }
        }
        return request
      })
      return !isNewerStrategyStoreVersion(stored, value)
    } catch (error) {
      throw putError ?? error
    }
  },
  remove: async (name) => {
    await run('readwrite', (store) => store.delete(name))
  },
}

const activeBackend = (): StrategyStorageBackend | null =>
  configuredBackend ?? (typeof indexedDB === 'undefined' ? null : indexedDbBackend)

/**
 * Replaces IndexedDB as the strategy store's storage. The store picks its
 * storage when it is created, so this must run before the store module loads.
 */
export const setStrategyStorageBackend = (backend: StrategyStorageBackend): void => {
  configuredBackend = backend
}

/** Resolves once every write started so far has been committed or failed. */
export const flushStrategyStoreWrites = async (): Promise<void> => {
  while (pendingWrites.size > 0) await Promise.all(pendingWrites)
}

/**
 * Resolves to whether the most recent write committed, and to false without
 * a storage, where nothing is persisted. Writes to a name commit in order and
 * each holds the whole store, so a committed one holds every change set
 * before it, whatever happened to the earlier writes.
 */
export const flushLatestStrategyStoreWrite = (): Promise<boolean> =>
  activeBackend() ? latestWrite : Promise.resolve(false)

// The first read decides whether anything gets persisted this session, so it
// gets more attempts than a write, spaced out so a lost IndexedDB server
// connection has time to come back.
const readWithRetries = async (
  backend: StrategyStorageBackend,
  name: string,
  attempts = READ_ATTEMPTS,
): Promise<Value | null> => {
  try {
    return await backend.read(name)
  } catch (error) {
    if (attempts <= 1) throw error
    await reconnect()
    await wait(READ_RETRY_DELAY_MS)
    return readWithRetries(backend, name, attempts - 1)
  }
}

/**
 * Notifies when another tab or worker committed a write to the strategy
 * store. A context never receives its own writes.
 */
export const subscribeStrategyStoreWritten = (listener: (name: string) => void): (() => void) => {
  ensureChannel()
  writtenListeners.add(listener)
  return () => writtenListeners.delete(listener)
}

/**
 * Storage for zustand `persist`: IndexedDB unless a backend was set. Without
 * either nothing is persisted.
 */
export const createStrategyStorage = (): PersistStorage<PersistedStrategies> | undefined => {
  const backend = activeBackend()
  if (!backend) return undefined
  return {
    getItem: async (name) => {
      let value: Value | null
      try {
        value = await readWithRetries(backend, name)
      } catch (error) {
        report('strategy-store-read', error)
        return null
      }
      readNames.add(name)
      return value
    },
    setItem: (name, value) => {
      // A write before a successful read would replace the persisted
      // records with the empty initial state, and a write from an outdated
      // tab would replace the newer version's records.
      if (!readNames.has(name) || strategyStoreVersion.isOutdated) {
        latestWrite = Promise.resolve(false)
        return
      }
      const write = runWrite(name, () => backend.write(name, value))
        .then((written) => {
          if (!written) {
            strategyStoreVersion.isOutdated = true
            return false
          }
          notifyWritten(name)
          return true
        })
        .catch((error: unknown) => {
          report('strategy-store-write', error)
          return false
        })
        .finally(() => pendingWrites.delete(write))
      pendingWrites.add(write)
      latestWrite = write
      return write
    },
    removeItem: async (name) => {
      if (strategyStoreVersion.isOutdated) return
      try {
        await runWrite(name, () => backend.remove(name))
        notifyWritten(name)
      } catch (error) {
        report('strategy-store-write', error)
      }
    },
  }
}
