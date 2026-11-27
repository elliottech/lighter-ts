import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageValue } from 'zustand/middleware'
import type { StrategyRecord } from '../engine/types'
import { createFileStrategyStorageBackend, readPersistedStrategies } from './fileStrategyStorage'

type Value = StorageValue<{ strategies: Record<string, StrategyRecord> }>

const NAME = 'lighter-strategies-v1'

const value = (ids: string[]): Value => ({
  version: 9,
  state: {
    strategies: Object.fromEntries(ids.map((id) => [id, { id } as StrategyRecord])),
  },
})

describe('createFileStrategyStorageBackend', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'strategy-store-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads null before anything was written', async () => {
    expect(await createFileStrategyStorageBackend(dir).read(NAME)).toBeNull()
  })

  it('reads back the last write and leaves no temporary file', async () => {
    const backend = createFileStrategyStorageBackend(join(dir, 'nested'))
    await backend.write(NAME, value(['a']))
    await backend.write(NAME, value(['a', 'b']))

    expect(await backend.read(NAME)).toEqual(value(['a', 'b']))
    expect(await readdir(join(dir, 'nested'))).toEqual([`${NAME}.json`])
  })

  it('keeps a stored value with a newer version', async () => {
    const backend = createFileStrategyStorageBackend(dir)
    const newer = { ...value(['a']), version: 10 }
    await backend.write(NAME, newer)

    expect(await backend.write(NAME, value(['b']))).toBe(false)
    expect(await backend.read(NAME)).toEqual(newer)
  })

  it('reads the persisted records synchronously, none before anything was written', async () => {
    expect(readPersistedStrategies(dir, NAME)).toEqual({})
    await createFileStrategyStorageBackend(dir).write(NAME, value(['a', 'b']))

    expect(readPersistedStrategies(dir, NAME)).toEqual(value(['a', 'b']).state.strategies)
  })

  it('removes the file, and removing a missing name succeeds', async () => {
    const backend = createFileStrategyStorageBackend(dir)
    await backend.write(NAME, value(['a']))
    await backend.remove(NAME)
    await backend.remove(NAME)

    expect(await backend.read(NAME)).toBeNull()
  })

  it('fails the read of a corrupt file', async () => {
    await writeFile(join(dir, `${NAME}.json`), '{"version":')

    await expect(createFileStrategyStorageBackend(dir).read(NAME)).rejects.toThrow()
  })
})

describe('strategy storage on a file backend', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'strategy-store-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const load = async () => {
    const storage = await import('../store/strategyStorage')
    storage.setStrategyStorageBackend(createFileStrategyStorageBackend(dir))
    return storage
  }

  it('persists writes after the first read and survives a restart', async () => {
    const first = await load()
    const storage = first.createStrategyStorage()
    expect(storage).toBeDefined()
    expect(await storage?.getItem(NAME)).toBeNull()
    void storage?.setItem(NAME, value(['a']))
    expect(await first.flushLatestStrategyStoreWrite()).toBe(true)

    vi.resetModules()
    const restarted = (await load()).createStrategyStorage()
    expect(await restarted?.getItem(NAME)).toEqual(value(['a']))
  })

  it('skips writes until the stored records were read', async () => {
    const storage = await load()
    void storage.createStrategyStorage()?.setItem(NAME, value(['a']))

    expect(await storage.flushLatestStrategyStoreWrite()).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })
})
