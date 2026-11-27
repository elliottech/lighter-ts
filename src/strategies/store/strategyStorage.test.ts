import type {
  AdvancedTwapConfig,
  StrategyRecord,
  StrategyStatus,
  TwapProgress,
  TwapStrategyRecord,
} from '../engine/types'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageValue } from 'zustand/middleware'

import { wsWorkingOrders } from '../engine/testUtils'

const { captureException } = vi.hoisted(() => ({
  captureException: vi.fn(),
}))

vi.mock('../..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../..')>()),
  errorReporting: { captureException },
}))

type Value = StorageValue<{ strategies: Record<string, StrategyRecord> }>

const NAME = 'lighter-strategies-v1'
const DATABASE = 'lighter-strategies'
const STORE = 'store'

const config = (): AdvancedTwapConfig => ({
  accountIndex: 0,
  marketId: 1,
  isAsk: 0,
  totalSize: 0.003,
  sliceCount: 3,
  baseIntervalMs: 1000,
  intervalJitter: 0,
  sizeJitter: 0,
  reduceOnly: false,
  maxSlippagePct: 1,
})

const progress = (status: StrategyStatus): TwapProgress => ({
  status,
  totalBaseAmount: 0.003,
  filledBaseAmount: 0.001,
  filledQuoteAmount: 2.5,
  makerBaseAmount: 0.001,
  failedBaseAmount: 0,
  consumedSlices: 1,
  nextActionAt: status === 'running' ? 1_700_000_001_000 : null,
})

const record = (id: string, status: StrategyStatus): TwapStrategyRecord => ({
  id,
  kind: 'advanced-twap',
  config: config(),
  progress: progress(status),
  createdAt: 1_700_000_000_000,
  workingOrders:
    status === 'running'
      ? wsWorkingOrders({
          order_id: `${id}-order`,
          market_index: 1,
          initial_base_amount: 0.001,
          remaining_base_amount: 0.001,
          price: 2500,
        })
      : {},
})

const value = (...records: StrategyRecord[]): Value => ({
  version: 9,
  state: {
    strategies: Object.fromEntries(records.map((r) => [r.id, r])),
  },
})

class FakeBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null
  postMessage() {}
  close() {}
}

class FakeLocalStorage {
  private items = new Map<string, string>()
  getItem(key: string) {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.items.set(key, value)
  }
}

// Safari: "UnknownError: Connection to Indexed Database server lost".
const failingOpen = () => {
  const request = Object.assign(new EventTarget(), {
    error: new DOMException('Connection to Indexed Database server lost', 'UnknownError'),
    onerror: null as (() => void) | null,
  })
  setTimeout(() => request.onerror?.(), 0)
  return request as unknown as IDBOpenDBRequest
}

// Safari closes a backgrounded page's connection without firing `close`.
// Closing the connection from the outside leaves the storage's cached
// connection in the same state: the next `transaction()` throws.
const closeLatest = (connections: IDBDatabase[]) => {
  const db = connections.at(-1)
  if (!db) throw new Error('no connection opened yet')
  db.close()
}

describe('strategyStorage connection recovery', () => {
  let factory: IDBFactory
  let connections: IDBDatabase[]
  let closeOnOpen: boolean
  let failOpens: number
  let abortNextReadwrite: boolean

  const readRaw = (name: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const open = factory.open(DATABASE, 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(name)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          db.close()
          resolve(request.result)
        }
      }
    })

  const writeRaw = (name: string, stored: Value): Promise<void> =>
    new Promise((resolve, reject) => {
      const open = factory.open(DATABASE, 1)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(stored, name)
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
      }
    })

  const createStorage = async () => {
    vi.resetModules()
    const { createStrategyStorage } = await import('./strategyStorage')
    const storage = createStrategyStorage()
    if (!storage) throw new Error('IndexedDB unavailable')
    return storage
  }

  // The first import of the module graph is slow under a loaded full run;
  // paid inside a test it times out and leaks connections into the next one.
  beforeAll(async () => {
    await import('./strategyStorage')
  }, 60_000)

  beforeEach(() => {
    factory = new IDBFactory()
    connections = []
    closeOnOpen = false
    failOpens = 0
    abortNextReadwrite = false
    vi.stubGlobal('indexedDB', {
      open: (name: string, version?: number) => {
        if (failOpens > 0) {
          failOpens -= 1
          return failingOpen()
        }
        const request = factory.open(name, version)
        request.addEventListener('success', () => {
          const db = request.result
          connections.push(db)
          if (closeOnOpen) db.close()
          const transaction = db.transaction.bind(db)
          db.transaction = (names, mode) => {
            const tx = transaction(names, mode)
            if (abortNextReadwrite && mode === 'readwrite') {
              abortNextReadwrite = false
              queueMicrotask(() => tx.abort())
            }
            return tx
          }
        })
        return request
      },
    })
    vi.stubGlobal('localStorage', new FakeLocalStorage())
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  // fake-indexeddb schedules on setImmediate, which stays real.
  const readWithRetryDelay = async (storage: Awaited<ReturnType<typeof createStorage>>) => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const read = storage.getItem(NAME)
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    return read
  }

  it('reads on a fresh connection when the cached one was closed', async () => {
    const storage = await createStorage()
    expect(await storage.getItem(NAME)).toBeNull()
    await storage.setItem(NAME, value(record('a', 'completed'), record('b', 'running')))
    expect(connections).toHaveLength(1)

    closeLatest(connections)

    expect(await storage.getItem(NAME)).toEqual(
      value(record('a', 'completed'), record('b', 'running')),
    )
    expect(connections).toHaveLength(2)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('writes on a fresh connection when the cached one was closed', async () => {
    const storage = await createStorage()
    await storage.getItem(NAME)

    closeLatest(connections)

    await storage.setItem(NAME, value(record('a', 'completed'), record('b', 'running')))
    expect(await readRaw(NAME)).toEqual(value(record('a', 'completed'), record('b', 'running')))
    expect(connections).toHaveLength(2)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('removes on a fresh connection when the cached one was closed', async () => {
    const storage = await createStorage()
    await storage.getItem(NAME)
    await storage.setItem(NAME, value(record('a', 'completed'), record('b', 'running')))

    closeLatest(connections)

    await storage.removeItem(NAME)
    expect(await readRaw(NAME)).toBeUndefined()
    expect(connections).toHaveLength(2)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('ignores strategies left in localStorage', async () => {
    const legacy = value(record('legacy', 'running'))
    localStorage.setItem(NAME, JSON.stringify(legacy))
    const storage = await createStorage()

    expect(await storage.getItem(NAME)).toBeNull()
    expect(await readRaw(NAME)).toBeUndefined()
    expect(localStorage.getItem(NAME)).toBe(JSON.stringify(legacy))
    expect(captureException).not.toHaveBeenCalled()
  })

  it('opens again when the open failed', async () => {
    failOpens = 1
    const storage = await createStorage()

    expect(await storage.getItem(NAME)).toBeNull()
    await storage.setItem(NAME, value(record('a', 'completed')))
    expect(await readRaw(NAME)).toEqual(value(record('a', 'completed')))
    expect(connections).toHaveLength(1)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('opens again on the next operation after every open attempt failed', async () => {
    failOpens = 4
    const storage = await createStorage()

    expect(await readWithRetryDelay(storage)).toBeNull()
    expect(connections).toHaveLength(0)
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'UnknownError' }),
      { tags: { feature: 'strategy-store-read' } },
    )

    expect(await storage.getItem(NAME)).toBeNull()
    await storage.setItem(NAME, value(record('a', 'completed')))
    expect(await readRaw(NAME)).toEqual(value(record('a', 'completed')))
    expect(connections).toHaveLength(1)
    expect(captureException).toHaveBeenCalledTimes(1)
  })

  it('writes again when the transaction aborted', async () => {
    const storage = await createStorage()
    await storage.getItem(NAME)
    await storage.setItem(NAME, value(record('a', 'completed')))

    abortNextReadwrite = true

    await storage.setItem(NAME, value(record('b', 'running')))
    expect(await readRaw(NAME)).toEqual(value(record('b', 'running')))
    expect(connections).toHaveLength(2)
    expect(captureException).not.toHaveBeenCalled()
  })

  it('keeps the newer write when an older one aborted', async () => {
    const storage = await createStorage()
    await storage.getItem(NAME)
    await storage.setItem(NAME, value(record('a', 'completed')))

    abortNextReadwrite = true

    await Promise.all([
      storage.setItem(NAME, value(record('older', 'running'))),
      storage.setItem(NAME, value(record('newer', 'completed'))),
    ])
    expect(await readRaw(NAME)).toEqual(value(record('newer', 'completed')))
    expect(captureException).not.toHaveBeenCalled()
  })

  it('keeps the older write when it aborted and the newer one failed', async () => {
    const storage = await createStorage()
    await storage.getItem(NAME)
    await storage.setItem(NAME, value(record('a', 'completed')))

    abortNextReadwrite = true
    const notCloneable = {
      ...value(record('newer', 'completed')),
      notCloneable: () => undefined,
    } as Value

    await Promise.all([
      storage.setItem(NAME, value(record('older', 'running'))),
      storage.setItem(NAME, notCloneable),
    ])
    expect(await readRaw(NAME)).toEqual(value(record('older', 'running')))
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'DataCloneError' }),
      { tags: { feature: 'strategy-store-write' } },
    )
  })

  it('flushes to whether the latest write committed, whatever came before it', async () => {
    const storage = await createStorage()
    const { flushLatestStrategyStoreWrite } = await import('./strategyStorage')
    await storage.getItem(NAME)
    const notCloneable = {
      ...value(record('a', 'running')),
      notCloneable: () => undefined,
    } as Value

    void storage.setItem(NAME, notCloneable)
    void storage.setItem(NAME, value(record('b', 'running')))
    expect(await flushLatestStrategyStoreWrite()).toBe(true)
    expect(await readRaw(NAME)).toEqual(value(record('b', 'running')))

    void storage.setItem(NAME, value(record('c', 'running')))
    void storage.setItem(NAME, notCloneable)
    expect(await flushLatestStrategyStoreWrite()).toBe(false)
  })

  it('flushes to false when the write was skipped because the read failed', async () => {
    failOpens = 4
    const storage = await createStorage()
    const { flushLatestStrategyStoreWrite } = await import('./strategyStorage')
    expect(await readWithRetryDelay(storage)).toBeNull()

    void storage.setItem(NAME, value(record('a', 'running')))
    expect(await flushLatestStrategyStoreWrite()).toBe(false)
  })

  it('flushes to false without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined)
    vi.resetModules()
    const { createStrategyStorage, flushLatestStrategyStoreWrite } = await import(
      './strategyStorage'
    )

    expect(createStrategyStorage()).toBeUndefined()
    expect(await flushLatestStrategyStoreWrite()).toBe(false)
  })

  it('keeps a newer version written by another tab when this tab is outdated', async () => {
    const seed = await createStorage()
    await seed.getItem(NAME)
    const newer = { ...value(record('a', 'running')), version: 10 }
    await seed.setItem(NAME, newer)

    vi.resetModules()
    const { useStrategyStore } = await import('./strategyStore')
    const { flushStrategyStoreWrites, strategyStoreVersion } = await import('./strategyStorage')
    await useStrategyStore.persist.rehydrate()
    expect(strategyStoreVersion.isOutdated).toBe(true)

    useStrategyStore.getState().upsert(record('b', 'running'))
    useStrategyStore.getState().remove('a')
    await useStrategyStore.persist.getOptions().storage?.removeItem(NAME)
    await flushStrategyStoreWrites()

    expect(await readRaw(NAME)).toEqual(newer)
  })

  it('keeps a newer version another tab wrote after this one loaded', async () => {
    const storage = await createStorage()
    await storage.getItem(NAME)
    const { flushLatestStrategyStoreWrite, strategyStoreVersion } = await import(
      './strategyStorage'
    )
    const newer = { ...value(record('a', 'running')), version: 10 }
    await writeRaw(NAME, newer)

    await storage.setItem(NAME, value(record('b', 'running')))

    expect(await flushLatestStrategyStoreWrite()).toBe(false)
    expect(strategyStoreVersion.isOutdated).toBe(true)
    expect(await readRaw(NAME)).toEqual(newer)
  })

  it('gives up after one reconnect when every connection is closing', async () => {
    closeOnOpen = true
    const storage = await createStorage()

    expect(await readWithRetryDelay(storage)).toBeNull()
    // transact reconnects once per read; getItem reads twice.
    expect(connections).toHaveLength(4)
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'InvalidStateError' }),
      { tags: { feature: 'strategy-store-read' } },
    )
  })
})
