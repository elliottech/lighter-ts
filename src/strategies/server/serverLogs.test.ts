import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createServerLogWriter,
  createServerOutputTee,
  listServerLogChunks,
  openServerLogs,
} from './serverLogs'

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const STAMP = new Date(NOW).toISOString()

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-logs-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const writer = (dir: string, chunkBytes = 1000, maxBytes = 3000) =>
  createServerLogWriter({ dir, chunkBytes, maxBytes, now: () => NOW, onError: vi.fn() })

const read = (dir: string) => listServerLogChunks(dir).map(({ path }) => readFileSync(path, 'utf8'))

const download = async (dir: string, size: 'small' | 'large') => {
  const logs = await openServerLogs(dir, size)
  const parts: Buffer[] = []
  for await (const part of logs.data) parts.push(part as Buffer)
  const text = gunzipSync(Buffer.concat(parts)).toString()
  return { bytes: logs.bytes, text }
}

describe('createServerLogWriter', () => {
  it('prefixes each line with the time, source and stream', () => {
    const dir = tempDir()
    const logs = writer(dir)
    logs.write('server', 'out', '{"kind":"progress"}\nhal')
    logs.write('server', 'err', 'boom\n')
    logs.write('server', 'out', 'f\n')
    logs.write('launcher', 'err', 'restarting\n')

    expect(read(dir)).toEqual([
      [
        `${STAMP} server out {"kind":"progress"}`,
        `${STAMP} server err boom`,
        `${STAMP} server out half`,
        `${STAMP} launcher err restarting`,
        '',
      ].join('\n'),
    ])
  })

  it('writes the lines still missing their newline on close', () => {
    const dir = tempDir()
    const logs = writer(dir)
    logs.write('server', 'err', 'fatal')
    expect(read(dir)).toEqual([])

    logs.close()

    expect(read(dir)).toEqual([`${STAMP} server err fatal\n`])
  })

  it('keeps a character split across two writes whole', () => {
    const dir = tempDir()
    const logs = writer(dir)
    const line = Buffer.from('prix: 3€\n')
    const split = line.indexOf(Buffer.from('€')) + 1
    logs.write('server', 'out', line.subarray(0, split))
    logs.write('server', 'out', line.subarray(split))

    expect(read(dir)).toEqual([`${STAMP} server out prix: 3€\n`])
  })

  it('ends the unfinished lines of a source on flush, so its next output starts a line', () => {
    const dir = tempDir()
    const logs = writer(dir, 10_000)
    const cut = Buffer.from('dies mid-line €')
    logs.write('server', 'out', cut.subarray(0, -1))
    logs.write('launcher', 'err', 'starting partial\n')
    logs.flush('server')
    logs.write('launcher', 'err', 'starting strategies server 1.2.3\n')
    logs.write('server', 'out', Buffer.from('listening\n'))

    expect(read(dir)).toEqual([
      `${STAMP} launcher err starting partial\n` +
        `${STAMP} server out dies mid-line \uFFFD\n` +
        `${STAMP} launcher err starting strategies server 1.2.3\n` +
        `${STAMP} server out listening\n`,
    ])
  })

  it('rotates past the chunk size and keeps the newest chunks within the max', () => {
    const dir = tempDir()
    const logs = writer(dir)
    const line = 'x'.repeat(100 - STAMP.length - ' server out \n'.length)
    for (let index = 0; index < 55; index++) logs.write('server', 'out', `${line}\n`)
    logs.close()

    const chunks = listServerLogChunks(dir)
    expect(chunks.map(({ seq }) => seq)).toEqual([4, 5, 6])
    expect(chunks.map(({ path }) => statSync(path).size)).toEqual([1000, 1000, 500])
  })

  it('keeps 2 chunks even when the max is below 2 chunks', () => {
    const dir = tempDir()
    const logs = writer(dir, 100, 0)
    for (let index = 0; index < 10; index++) logs.write('server', 'out', `${'y'.repeat(60)}\n`)

    expect(listServerLogChunks(dir)).toHaveLength(2)
  })

  it('appends to the newest chunk after a restart', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'server.0000000007.log'), 'old\n')
    const logs = writer(dir)
    logs.write('launcher', 'err', 'started\n')

    expect(readdirSync(dir)).toEqual(['server.0000000007.log'])
    expect(read(dir)).toEqual([`old\n${STAMP} launcher err started\n`])
  })

  it('reports a failed write once and does not throw', () => {
    const dir = tempDir()
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, '')
    const onError = vi.fn()
    const logs = createServerLogWriter({ dir: file, maxBytes: 3000, now: () => NOW, onError })

    expect(logs.isFailing()).toBe(false)
    logs.write('server', 'out', 'a\n')
    logs.write('server', 'out', 'b\n')

    expect(onError).toHaveBeenCalledTimes(1)
    expect(logs.isFailing()).toBe(true)
  })
})

describe('createServerOutputTee', () => {
  const tee = (asService: boolean, dir: string) => {
    const drain = new EventEmitter()
    const output = {
      write: vi.fn((_data: Buffer | string) => true),
      once: (event: 'drain', listener: () => void) => drain.once(event, listener),
    }
    const logs = createServerLogWriter({ dir, maxBytes: 3000, now: () => NOW, onError: vi.fn() })
    const handler = createServerOutputTee({
      asService,
      writer: logs,
      stream: 'err',
      output,
      logsDir: dir,
    })
    return { handler, output, drain }
  }

  it('as a service with a working writer, logs the output without copying it', () => {
    const dir = tempDir()
    const { handler, output } = tee(true, dir)

    handler(Buffer.from('boom\n'))

    expect(read(dir)).toEqual([`${STAMP} server err boom\n`])
    expect(output.write).not.toHaveBeenCalled()
  })

  it('not as a service, logs the output and copies it', () => {
    const dir = tempDir()
    const { handler, output } = tee(false, dir)

    handler(Buffer.from('boom\n'))

    expect(read(dir)).toEqual([`${STAMP} server err boom\n`])
    expect(output.write).toHaveBeenCalledWith(Buffer.from('boom\n'))
  })

  it('skips the copy while the output is behind, then says so', () => {
    const dir = tempDir()
    const { handler, output, drain } = tee(false, dir)
    output.write.mockReturnValueOnce(false)

    handler(Buffer.from('one\n'))
    handler(Buffer.from('two\n'))
    drain.emit('drain')
    handler(Buffer.from('three\n'))

    expect(read(dir)).toEqual([
      [`${STAMP} server err one`, `${STAMP} server err two`, `${STAMP} server err three`, ''].join(
        '\n',
      ),
    ])
    expect(output.write.mock.calls.map(([data]) => String(data))).toEqual([
      'one\n',
      `strategies server output was skipped while this output was behind, the logs have all of it: ${dir}\n`,
      'three\n',
    ])
  })

  it('says nothing on drain when nothing was skipped', () => {
    const dir = tempDir()
    const { handler, output, drain } = tee(false, dir)
    output.write.mockReturnValueOnce(false)

    handler(Buffer.from('one\n'))
    drain.emit('drain')

    expect(output.write.mock.calls.map(([data]) => String(data))).toEqual(['one\n'])
  })

  it('drops the copy while the output is behind even when the log cannot be written', () => {
    const file = join(tempDir(), 'not-a-dir')
    writeFileSync(file, '')
    const { handler, output, drain } = tee(true, file)
    output.write.mockReturnValueOnce(false)

    handler(Buffer.from('one\n'))
    handler(Buffer.from('two\n'))
    drain.emit('drain')

    expect(output.write.mock.calls.map(([data]) => String(data))).toEqual([
      'one\n',
      'strategies server output was dropped while this output was behind\n',
    ])
  })

  it('as a service with a failing writer, copies the output', () => {
    const file = join(tempDir(), 'not-a-dir')
    writeFileSync(file, '')
    const { handler, output } = tee(true, file)

    handler(Buffer.from('boom\n'))

    expect(output.write).toHaveBeenCalledWith(Buffer.from('boom\n'))
  })
})

describe('openServerLogs', () => {
  const fill = (dir: string) => {
    for (const seq of [1, 2, 3])
      writeFileSync(join(dir, `server.000000000${seq}.log`), `chunk ${seq}\n`)
    writeFileSync(join(dir, 'other.log'), 'ignored\n')
  }

  it('gzips the last 2 chunks for small, oldest first', async () => {
    const dir = tempDir()
    fill(dir)

    expect(await download(dir, 'small')).toEqual({ bytes: 16, text: 'chunk 2\nchunk 3\n' })
  })

  it('gzips every chunk for large, oldest first', async () => {
    const dir = tempDir()
    fill(dir)

    expect(await download(dir, 'large')).toEqual({
      bytes: 24,
      text: 'chunk 1\nchunk 2\nchunk 3\n',
    })
  })

  it('reads a chunk only up to its size when opened', async () => {
    const dir = tempDir()
    const logs = writer(dir)
    logs.write('server', 'out', 'before\n')
    const opened = await openServerLogs(dir, 'small')
    logs.write('server', 'out', 'after\n')

    const parts: Buffer[] = []
    for await (const part of opened.data) parts.push(part as Buffer)

    expect(gunzipSync(Buffer.concat(parts)).toString()).toBe(`${STAMP} server out before\n`)
  })

  it('gives an empty gzip when there are no logs yet', async () => {
    expect(await download(join(tempDir(), 'missing'), 'large')).toEqual({ bytes: 0, text: '' })
  })
})
