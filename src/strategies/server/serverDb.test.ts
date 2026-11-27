import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_STORED_ERRORS, ServerDbLockedError, lockServerHome, openServerDb } from './serverDb'

const DB_MODULE = join(import.meta.dirname, 'serverDb.ts')

const storedError = (timestamp: number) => ({
  timestamp,
  name: 'Error',
  message: `failure at ${timestamp}`,
  stack: `Error: failure at ${timestamp}\n    at server.worker.mjs:1:1`,
  tags: { feature: 'strategies-server-api' },
  debugIds: { 'server.worker.mjs': 'debug-id' },
  strategyId: 's1',
  version: '1.0.0',
})

const SIGNER = { seed: 'ab'.repeat(40), accountIndex: 7, apiKeyIndex: 3 }

const startServer = (dir: string, signer?: typeof SIGNER) => {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--expose-gc',
      '--input-type=module',
      '-e',
      `const { openServerDb } = await import(${JSON.stringify(DB_MODULE)})
      try {
        const db = openServerDb(${JSON.stringify(dir)})
        ${signer ? `db.saveSigner(${JSON.stringify(signer)})` : ''}
        globalThis.gc()
        console.log('locked')
        setInterval(() => {}, 1000)
      } catch (error) {
        console.log(error.message)
        process.exit(1)
      }`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const firstLine = new Promise<string>((resolve) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.includes('\n')) resolve(output.split('\n')[0] ?? '')
    })
  })
  return { child, firstLine }
}

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })

describe.skipIf(!process.getBuiltinModule?.('node:sqlite'))('openServerDb', () => {
  let dir: string
  const children: ChildProcess[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'strategies-lock-'))
  })

  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL')
      await exited(child)
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('creates the dir and throws while the lock is held', () => {
    const db = openServerDb(join(dir, 'nested'))

    expect(existsSync(join(dir, 'nested', 'server.lock.db'))).toBe(true)
    expect(() => openServerDb(join(dir, 'nested'))).toThrow('Another strategies server holds')

    db.release()
    openServerDb(join(dir, 'nested')).release()
  })

  it('locks one launcher per home, apart from the store lock', () => {
    const release = lockServerHome(dir)

    expect(existsSync(join(dir, 'launcher.lock.db'))).toBe(true)
    expect(() => lockServerHome(dir)).toThrow(ServerDbLockedError)
    openServerDb(join(dir, 'store')).release()

    release()
    lockServerHome(dir)()
  })

  it('keeps the database and its journal readable only by their owner', () => {
    const db = openServerDb(dir)
    db.saveSigner(SIGNER)
    db.saveSigner({ ...SIGNER, seed: 'cd'.repeat(40) })

    for (const file of ['server.lock.db', 'server.lock.db-journal']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
    }
    db.release()
  })

  it('restricts a database left readable by an older server', () => {
    openServerDb(dir).release()
    chmodSync(join(dir, 'server.lock.db'), 0o644)

    openServerDb(dir).release()

    expect(statSync(join(dir, 'server.lock.db')).mode & 0o777).toBe(0o600)
  })

  it('has no signer until one is saved, and keeps the latest one', () => {
    const db = openServerDb(dir)
    expect(db.readSigner()).toBeNull()

    db.saveSigner(SIGNER)
    db.saveSigner({ ...SIGNER, seed: 'cd'.repeat(40), apiKeyIndex: 4 })
    db.release()

    const reopened = openServerDb(dir)
    expect(reopened.readSigner()).toEqual({ ...SIGNER, seed: 'cd'.repeat(40), apiKeyIndex: 4 })
    reopened.release()
  })

  it('keeps the pending signer across a reopen until it is adopted as the signer', () => {
    const pending = { seed: 'ef'.repeat(32), accountIndex: 7, apiKeyIndex: 4, createdAt: 1000 }
    const db = openServerDb(dir)
    expect(db.readPendingSigner()).toBeNull()
    expect(db.adoptPendingSigner()).toBeNull()

    db.savePendingSigner(pending)
    db.release()

    const reopened = openServerDb(dir)
    expect(reopened.readPendingSigner()).toEqual(pending)
    expect(reopened.adoptPendingSigner()).toEqual({
      seed: 'ef'.repeat(32),
      accountIndex: 7,
      apiKeyIndex: 4,
    })
    expect(reopened.readPendingSigner()).toBeNull()
    expect(reopened.readSigner()).toEqual({
      seed: 'ef'.repeat(32),
      accountIndex: 7,
      apiKeyIndex: 4,
    })
    reopened.release()
  })

  it('keeps pending stops in order until they are deleted, across a reopen', () => {
    const db = openServerDb(dir)
    expect(db.readPendingStops()).toEqual([])

    db.savePendingStop({ id: 's1', reason: 'Stopped by user' })
    db.savePendingStop({ id: 's2', reason: 'other' })
    db.savePendingStop({ id: 's1', reason: 'again' })
    db.release()

    const reopened = openServerDb(dir)
    expect(reopened.readPendingStops()).toEqual([
      { id: 's1', reason: 'Stopped by user' },
      { id: 's2', reason: 'other' },
    ])
    reopened.deletePendingStop('s1')
    expect(reopened.readPendingStops()).toEqual([{ id: 's2', reason: 'other' }])
    reopened.release()
  })

  it('stops a second process while the first one runs', async () => {
    const first = startServer(dir)
    children.push(first.child)
    expect(await first.firstLine).toBe('locked')

    const second = startServer(dir)
    children.push(second.child)
    expect(await second.firstLine).toContain('Another strategies server holds')
  })

  it('frees the lock when the holder is killed with SIGKILL', async () => {
    const first = startServer(dir)
    children.push(first.child)
    expect(await first.firstLine).toBe('locked')
    expect(() => openServerDb(dir)).toThrow('Another strategies server holds')

    first.child.kill('SIGKILL')
    await exited(first.child)

    openServerDb(dir).release()
  })

  it('keeps a signer saved by a process that was killed with SIGKILL, while holding the lock', async () => {
    const first = startServer(dir, SIGNER)
    children.push(first.child)
    expect(await first.firstLine).toBe('locked')

    first.child.kill('SIGKILL')
    await exited(first.child)

    const db = openServerDb(dir)
    expect(db.readSigner()).toEqual(SIGNER)
    db.release()
  })

  it('keeps the latest errors and their ack across restarts', () => {
    const db = openServerDb(dir)
    expect(db.readUnackedErrors(50)).toEqual({ errors: [], skippedErrorsCount: 0 })
    expect(db.readLastAckErrorId()).toBe(0)

    const saved = [1000, 1000, 2000].map((timestamp) => db.saveError(storedError(timestamp)))
    expect(saved.map(({ id }) => id)).toEqual([1, 2, 3])
    db.ackErrors(1)
    db.release()

    const reopened = openServerDb(dir)
    expect(reopened.readLastAckErrorId()).toBe(1)
    expect(reopened.readUnackedErrors(50)).toEqual({
      errors: [
        { ...storedError(1000), id: 2 },
        { ...storedError(2000), id: 3 },
      ],
      skippedErrorsCount: 0,
    })
    expect(reopened.readUnackedErrors(1)).toEqual({
      errors: [{ ...storedError(2000), id: 3 }],
      skippedErrorsCount: 1,
    })
    reopened.release()
  })

  it('skips an error whose payload does not parse and keeps the others', () => {
    const db = openServerDb(dir)
    for (const timestamp of [1000, 2000, 3000]) db.saveError(storedError(timestamp))
    db.release()
    const sqlite = process.getBuiltinModule('node:sqlite')
    const raw = new sqlite.DatabaseSync(join(dir, 'server.lock.db'))
    raw.prepare("UPDATE error SET payload = '{broken' WHERE id = 2").run()
    raw.close()

    const reopened = openServerDb(dir)
    expect(reopened.readUnackedErrors(50)).toEqual({
      errors: [
        { ...storedError(1000), id: 1 },
        { ...storedError(3000), id: 3 },
      ],
      skippedErrorsCount: 1,
    })
    reopened.release()
  })

  it('counts the unacked errors left out by the limit, not the acked ones', () => {
    const db = openServerDb(dir)
    for (const timestamp of [1000, 2000, 3000, 4000, 5000, 6000]) {
      db.saveError(storedError(timestamp))
    }
    db.ackErrors(2)

    expect(db.readUnackedErrors(2)).toEqual({
      errors: [
        { ...storedError(5000), id: 5 },
        { ...storedError(6000), id: 6 },
      ],
      skippedErrorsCount: 2,
    })
    db.release()
  })

  it('never moves the ack back nor past the latest error', () => {
    const db = openServerDb(dir)
    for (const timestamp of [1000, 2000, 3000]) db.saveError(storedError(timestamp))

    db.ackErrors(99)
    expect(db.readLastAckErrorId()).toBe(3)
    db.ackErrors(1)
    expect(db.readLastAckErrorId()).toBe(3)
    expect(db.readUnackedErrors(50)).toEqual({ errors: [], skippedErrorsCount: 0 })

    db.saveError(storedError(4000))
    expect(db.readUnackedErrors(50)).toEqual({
      errors: [{ ...storedError(4000), id: 4 }],
      skippedErrorsCount: 0,
    })
    db.release()
  })

  it(`keeps only the latest ${MAX_STORED_ERRORS} errors`, () => {
    const db = openServerDb(dir)
    for (let index = 1; index <= MAX_STORED_ERRORS + 5; index++) db.saveError(storedError(index))

    const { errors, skippedErrorsCount } = db.readUnackedErrors(MAX_STORED_ERRORS + 5)
    expect(skippedErrorsCount).toBe(0)
    expect(errors).toHaveLength(MAX_STORED_ERRORS)
    expect(errors[0]).toEqual({ ...storedError(6), id: 6 })
    expect(errors.at(-1)).toEqual({
      ...storedError(MAX_STORED_ERRORS + 5),
      id: MAX_STORED_ERRORS + 5,
    })
    db.ackErrors(3)
    expect(db.readLastAckErrorId()).toBe(0)
    db.release()
  })

  it('lets exactly one of several processes started at once take the lock', async () => {
    const servers = Array.from({ length: 6 }, () => startServer(dir))
    children.push(...servers.map(({ child }) => child))

    const lines = await Promise.all(servers.map(({ firstLine }) => firstLine))

    expect(lines.filter((line) => line === 'locked')).toHaveLength(1)
    expect(lines.filter((line) => line.includes('Another strategies server holds'))).toHaveLength(5)
  })
})
