import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StrategiesServerError } from '../wsProtocol'

export const SERVER_DB_FILE = 'server.lock.db'
export const LAUNCHER_LOCK_FILE = 'launcher.lock.db'
const SQLITE_BUSY = 5
export const MAX_STORED_ERRORS = 1000

/** The signer the server's worker authenticates with. */
export interface StoredSigner {
  seed: string
  accountIndex: number
  apiKeyIndex: number
}

/** The signer of a key registration the frontend was asked to complete. */
export interface PendingSigner extends StoredSigner {
  /** Epoch ms the seed was generated at. */
  createdAt: number
}

/** A stop accepted while the worker was paused, sent to the next worker. */
export interface PendingStop {
  id: string
  reason: string
}

export interface UnackedErrors {
  errors: StrategiesServerError[]
  skippedErrorsCount: number
}

export interface ServerDb {
  readSigner: () => StoredSigner | null
  saveSigner: (signer: StoredSigner) => void
  readPendingSigner: () => PendingSigner | null
  savePendingSigner: (signer: PendingSigner) => void
  /** Makes the pending signer the signer, once its key is registered. Null without one. */
  adoptPendingSigner: () => StoredSigner | null
  readPendingStops: () => PendingStop[]
  savePendingStop: (stop: PendingStop) => void
  deletePendingStop: (id: string) => void
  /** Stores the error with the next id and drops all but the latest `MAX_STORED_ERRORS`. */
  saveError: (error: Omit<StrategiesServerError, 'id'>) => StrategiesServerError
  /** The latest `limit` errors after the acked one, by increasing id, and how
   *  many others after the acked one were left out. */
  readUnackedErrors: (limit: number) => UnackedErrors
  /** The id of the last error a frontend forwarded to Sentry; 0 before any. */
  readLastAckErrorId: () => number
  /** Moves the ack to the latest stored error up to `lastErrorId`; never moves it back. */
  ackErrors: (lastErrorId: number) => void
  release: () => void
}

export class ServerDbLockedError extends Error {}

// Closing the database, or letting it be garbage collected, drops the lock.
const heldDbs = new Set<object>()

/**
 * Opens the SQLite file at `path` and takes an exclusive lock on it, or throws
 * `ServerDbLockedError` when another process holds it. The OS releases the
 * lock when the process dies, however it dies, so there is no stale lock to
 * take over. In `locking_mode = EXCLUSIVE` the lock outlives each commit.
 */
const openLockedDb = (path: string) => {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) {
    throw new Error(`The strategies server needs Node 22.13 or newer, running ${process.version}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  // SQLite gives its journal, which can hold a replaced seed, the db file's mode.
  closeSync(openSync(path, 'a', 0o600))
  chmodSync(path, 0o600)
  if (existsSync(`${path}-journal`)) chmodSync(`${path}-journal`, 0o600)
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) {
      throw new ServerDbLockedError(`Another strategies server holds ${path}`)
    }
    throw error
  }
  return db
}

/**
 * Keeps `<home>/launcher.lock.db` locked for one launcher per home, so a
 * second one cannot touch the logs or the versions; see `openLockedDb`.
 */
export const lockServerHome = (home: string): (() => void) => {
  const db = openLockedDb(join(home, LAUNCHER_LOCK_FILE))
  heldDbs.add(db)
  return () => {
    if (!heldDbs.delete(db)) return
    db.close()
  }
}

/**
 * Opens `<dir>/server.lock.db` and keeps it locked, see `openLockedDb`, so the
 * signer written here is durable while no other process can read it.
 */
export const openServerDb = (dir: string): ServerDb => {
  const db = openLockedDb(join(dir, SERVER_DB_FILE))
  db.exec(`CREATE TABLE IF NOT EXISTS signer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seed TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    api_key_index INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS pending_signer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seed TEXT NOT NULL,
    account_index INTEGER NOT NULL,
    api_key_index INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS pending_stop (
    id TEXT PRIMARY KEY,
    reason TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS error (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS error_ack (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_ack_error_id INTEGER NOT NULL
  )`)
  db.exec('COMMIT')
  heldDbs.add(db)

  const select = db.prepare('SELECT seed, account_index, api_key_index FROM signer WHERE id = 1')
  const upsert = db.prepare(
    `INSERT INTO signer (id, seed, account_index, api_key_index) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       seed = excluded.seed,
       account_index = excluded.account_index,
       api_key_index = excluded.api_key_index`,
  )
  const selectPending = db.prepare(
    'SELECT seed, account_index, api_key_index, created_at FROM pending_signer WHERE id = 1',
  )
  const upsertPending = db.prepare(
    `INSERT INTO pending_signer (id, seed, account_index, api_key_index, created_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       seed = excluded.seed,
       account_index = excluded.account_index,
       api_key_index = excluded.api_key_index,
       created_at = excluded.created_at`,
  )
  const deletePending = db.prepare('DELETE FROM pending_signer WHERE id = 1')
  const readPendingSigner = (): PendingSigner | null => {
    const row = selectPending.get() as
      | { seed: string; account_index: number; api_key_index: number; created_at: number }
      | undefined
    if (!row) return null
    return {
      seed: row.seed,
      accountIndex: row.account_index,
      apiKeyIndex: row.api_key_index,
      createdAt: row.created_at,
    }
  }
  const selectStops = db.prepare('SELECT id, reason FROM pending_stop ORDER BY rowid')
  const upsertStop = db.prepare(
    'INSERT INTO pending_stop (id, reason) VALUES (?, ?) ON CONFLICT (id) DO NOTHING',
  )
  const deleteStop = db.prepare('DELETE FROM pending_stop WHERE id = ?')
  const insertError = db.prepare('INSERT INTO error (timestamp, payload) VALUES (?, ?)')
  const trimErrors = db.prepare('DELETE FROM error WHERE id <= ?')
  const selectUnackedErrors = db.prepare(
    'SELECT id, timestamp, payload FROM error WHERE id > ? ORDER BY id DESC LIMIT ?',
  )
  const countUnackedErrors = db.prepare('SELECT COUNT(*) AS count FROM error WHERE id > ?')
  const selectAck = db.prepare('SELECT last_ack_error_id FROM error_ack WHERE id = 1')
  const selectAckTarget = db.prepare('SELECT id FROM error WHERE id <= ? ORDER BY id DESC LIMIT 1')
  const upsertAck = db.prepare(
    `INSERT INTO error_ack (id, last_ack_error_id) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET last_ack_error_id = excluded.last_ack_error_id`,
  )
  const readLastAckErrorId = (): number =>
    (selectAck.get() as { last_ack_error_id: number } | undefined)?.last_ack_error_id ?? 0

  return {
    readSigner: () => {
      const row = select.get() as
        | { seed: string; account_index: number; api_key_index: number }
        | undefined
      if (!row) return null
      return { seed: row.seed, accountIndex: row.account_index, apiKeyIndex: row.api_key_index }
    },
    saveSigner: ({ seed, accountIndex, apiKeyIndex }) => {
      upsert.run(seed, accountIndex, apiKeyIndex)
    },
    readPendingSigner,
    savePendingSigner: ({ seed, accountIndex, apiKeyIndex, createdAt }) => {
      upsertPending.run(seed, accountIndex, apiKeyIndex, createdAt)
    },
    adoptPendingSigner: () => {
      const pending = readPendingSigner()
      if (!pending) return null
      const { seed, accountIndex, apiKeyIndex } = pending
      db.exec('BEGIN')
      try {
        upsert.run(seed, accountIndex, apiKeyIndex)
        deletePending.run()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return { seed, accountIndex, apiKeyIndex }
    },
    readPendingStops: () =>
      (selectStops.all() as { id: string; reason: string }[]).map(({ id, reason }) => ({
        id,
        reason,
      })),
    savePendingStop: ({ id, reason }) => {
      upsertStop.run(id, reason)
    },
    deletePendingStop: (id) => {
      deleteStop.run(id)
    },
    saveError: ({ timestamp, ...payload }) => {
      db.exec('BEGIN')
      let id: number
      try {
        id = Number(insertError.run(timestamp, JSON.stringify(payload)).lastInsertRowid)
        trimErrors.run(id - MAX_STORED_ERRORS)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return { id, timestamp, ...payload }
    },
    readUnackedErrors: (limit) => {
      const lastAckErrorId = readLastAckErrorId()
      const rows = selectUnackedErrors.all(lastAckErrorId, limit) as {
        id: number
        timestamp: number
        payload: string
      }[]
      const { count } = countUnackedErrors.get(lastAckErrorId) as { count: number }
      const errors = rows.reverse().flatMap(({ id, timestamp, payload }) => {
        try {
          const error = JSON.parse(payload) as Omit<StrategiesServerError, 'id' | 'timestamp'>
          return [{ ...error, id, timestamp }]
        } catch {
          return []
        }
      })
      return { errors, skippedErrorsCount: count - errors.length }
    },
    readLastAckErrorId,
    ackErrors: (lastErrorId) => {
      const target = selectAckTarget.get(lastErrorId) as { id: number } | undefined
      if (!target || target.id <= readLastAckErrorId()) return
      upsertAck.run(target.id)
    },
    release: () => {
      if (!heldDbs.delete(db)) return
      db.close()
    },
  }
}
