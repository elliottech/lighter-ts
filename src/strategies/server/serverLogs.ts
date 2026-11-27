import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { join } from 'node:path'
import { type Readable, pipeline } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { createGzip } from 'node:zlib'
import type { StrategiesServerLogsSize } from '../wsProtocol'

const MB = 1024 * 1024
export const SERVER_LOGS_DIR = 'logs'
export const SERVER_LOG_CHUNK_BYTES = 10 * MB
export const SERVER_LOGS_MAX_MB_ENV = 'STRATEGIES_SERVER_LOGS_MAX_MB'
export const DEFAULT_SERVER_LOGS_MAX_MB = 500
export const SMALL_SERVER_LOGS_CHUNKS = 2
export const MIN_SERVER_LOGS_MAX_MB = (SMALL_SERVER_LOGS_CHUNKS * SERVER_LOG_CHUNK_BYTES) / MB
export const MAX_SERVER_LOGS_MAX_MB = 1_000_000
// A line with no newline yet is written once it grows past this.
const MAX_PARTIAL_LINE = 64 * 1024
const CHUNK_FILE = /^server\.(\d+)\.log$/

export type ServerLogSource = 'launcher' | 'server'
export type ServerLogStream = 'out' | 'err'

export const serverLogsDir = (home: string): string => join(home, SERVER_LOGS_DIR)

export const serverLogsMaxBytes = (maxMb: number): number => maxMb * MB

const chunkName = (seq: number) => `server.${String(seq).padStart(10, '0')}.log`

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** The log chunks in `dir`, oldest first. */
export const listServerLogChunks = (dir: string): { seq: number; path: string }[] => {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  return names
    .flatMap((name) => {
      const match = CHUNK_FILE.exec(name)
      return match ? [{ seq: Number(match[1]), path: join(dir, name) }] : []
    })
    .sort((a, b) => a.seq - b.seq)
}

export interface ServerLogWriter {
  /** Appends every complete line of `data`, prefixed with the time, source and stream. */
  write: (source: ServerLogSource, stream: ServerLogStream, data: string | Buffer) => void
  /** Writes `source`'s lines still missing their newline, so the next output starts a line. */
  flush: (source: ServerLogSource) => void
  /** Writes the lines still missing their newline. */
  close: () => void
  /** Whether the last write failed, so lines are being dropped. */
  isFailing: () => boolean
}

/**
 * Appends to `server.<seq>.log` chunks in `dir`, starting a new chunk once the
 * current one would grow past `chunkBytes` and deleting the oldest beyond
 * `maxBytes` (at least SMALL_SERVER_LOGS_CHUNKS are kept). Never throws: a
 * failed write is dropped and `onError` called once until a write succeeds.
 */
export const createServerLogWriter = ({
  dir,
  maxBytes,
  chunkBytes = SERVER_LOG_CHUNK_BYTES,
  now,
  onError,
}: {
  dir: string
  maxBytes: number
  chunkBytes?: number
  now: () => number
  onError: (error: unknown) => void
}): ServerLogWriter => {
  const maxChunks = Math.max(SMALL_SERVER_LOGS_CHUNKS, Math.floor(maxBytes / chunkBytes))
  const partial = new Map<string, string>()
  const decoders = new Map<string, StringDecoder>()
  let fd: number | null = null
  let seq = 0
  let size = 0
  let failing = false

  const trim = () => {
    const chunks = listServerLogChunks(dir)
    for (const { path } of chunks.slice(0, Math.max(0, chunks.length - maxChunks))) {
      try {
        unlinkSync(path)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
  }

  const openChunk = (next: number): number => {
    const opened = openSync(join(dir, chunkName(next)), 'a', 0o600)
    fd = opened
    seq = next
    size = fstatSync(opened).size
    return opened
  }

  const closeChunk = () => {
    if (fd === null) return
    const open = fd
    fd = null
    closeSync(open)
  }

  const append = (text: string) => {
    let target = fd
    if (target === null) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      target = openChunk(listServerLogChunks(dir).at(-1)?.seq ?? 1)
      trim()
    }
    const bytes = Buffer.from(text)
    if (size > 0 && size + bytes.length > chunkBytes) {
      closeChunk()
      target = openChunk(seq + 1)
      trim()
    }
    let written = 0
    while (written < bytes.length) written += writeSync(target, bytes, written)
    size += bytes.length
  }

  const appendSafely = (text: string) => {
    if (!text) return
    try {
      append(text)
      failing = false
    } catch (error) {
      try {
        closeChunk()
      } catch {}
      if (failing) return
      failing = true
      onError(error)
    }
  }

  const format = (source: ServerLogSource, stream: ServerLogStream, line: string) =>
    `${new Date(now()).toISOString()} ${source} ${stream} ${line}\n`

  const flush = (source: ServerLogSource) => {
    const rest = (['out', 'err'] as const).map((stream) => {
      const key = `${source} ${stream}`
      const line = `${partial.get(key) ?? ''}${decoders.get(key)?.end() ?? ''}`
      partial.delete(key)
      decoders.delete(key)
      return line ? format(source, stream, line) : ''
    })
    appendSafely(rest.join(''))
  }

  return {
    write: (source, stream, data) => {
      const key = `${source} ${stream}`
      let text = data
      if (typeof text !== 'string') {
        let decoder = decoders.get(key)
        if (!decoder) {
          decoder = new StringDecoder('utf8')
          decoders.set(key, decoder)
        }
        text = decoder.write(text)
      }
      const lines = `${partial.get(key) ?? ''}${text}`.split('\n')
      const rest = lines.pop() ?? ''
      if (rest.length > MAX_PARTIAL_LINE) {
        lines.push(rest)
        partial.delete(key)
      } else if (rest) partial.set(key, rest)
      else partial.delete(key)
      appendSafely(lines.map((line) => format(source, stream, line)).join(''))
    },
    flush,
    close: () => {
      flush('launcher')
      flush('server')
      try {
        closeChunk()
      } catch {}
    },
    isFailing: () => failing,
  }
}

/**
 * A `'data'` handler for the master's `stream`: always logs it, and copies it
 * to `output` too when not a service or while the log cannot be written, so
 * a service's journal keeps only the launcher's own lines. While `output` is
 * behind (a paused `less`) the copy is dropped instead of queued.
 */
export const createServerOutputTee = ({
  asService,
  writer,
  stream,
  output,
  logsDir,
}: {
  asService: boolean
  writer: ServerLogWriter
  stream: ServerLogStream
  logsDir: string
  output: {
    write: (data: Buffer | string) => boolean
    once: (event: 'drain', listener: () => void) => unknown
  }
}): ((data: Buffer) => void) => {
  let behind = false
  let skipped = false
  return (data) => {
    writer.write('server', stream, data)
    if (asService && !writer.isFailing()) return
    if (behind) {
      skipped = true
      return
    }
    if (output.write(data)) return
    behind = true
    output.once('drain', () => {
      behind = false
      if (!skipped) return
      skipped = false
      output.write(
        writer.isFailing()
          ? 'strategies server output was dropped while this output was behind\n'
          : `strategies server output was skipped while this output was behind, the logs have all of it: ${logsDir}\n`,
      )
    })
  }
}

export interface ServerLogs {
  /** The uncompressed size of the logs `data` holds. */
  bytes: number
  /** The gzip of the chunks, oldest first. Destroy it to stop early. */
  data: Readable
}

/**
 * Opens the last SMALL_SERVER_LOGS_CHUNKS chunks (`small`) or all of them
 * (`large`) up to their size now, so a chunk rotated away meanwhile is still read.
 */
export const openServerLogs = async (
  dir: string,
  size: StrategiesServerLogsSize,
): Promise<ServerLogs> => {
  const chunks = listServerLogChunks(dir)
  const selected = size === 'small' ? chunks.slice(-SMALL_SERVER_LOGS_CHUNKS) : chunks
  const files: { handle: FileHandle; size: number }[] = []
  const closeAll = () => Promise.allSettled(files.map(({ handle }) => handle.close()))
  try {
    for (const { path } of selected) {
      let handle: FileHandle
      try {
        handle = await open(path, 'r')
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      const file = { handle, size: 0 }
      files.push(file)
      file.size = (await handle.stat()).size
    }
  } catch (error) {
    await closeAll()
    throw error
  }
  async function* read() {
    try {
      for (const { handle, size: end } of files) {
        if (end === 0) continue
        yield* handle.createReadStream({ start: 0, end: end - 1, autoClose: false })
      }
    } finally {
      await closeAll()
    }
  }
  const data = pipeline(read(), createGzip(), () => {}) as unknown as Readable
  return { bytes: files.reduce((total, file) => total + file.size, 0), data }
}
