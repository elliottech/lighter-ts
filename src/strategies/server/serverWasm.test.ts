import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { initServerWasm, shouldReportSignerError, verifySignerFiles } from './serverWasm'

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

const wasm = Buffer.from('\0asm signer')
const runtime = Buffer.from('globalThis.Go = class {}')
const manifest = { protocol: 2, sha256: sha256(wasm), runtimeSha256: sha256(runtime) }

const tampered = (data: Buffer) => {
  const copy = Buffer.from(data)
  const last = copy.length - 1
  copy.writeUInt8(copy.readUInt8(last) ^ 1, last)
  return copy
}

describe('verifySignerFiles', () => {
  it('accepts files matching the manifest', () => {
    expect(() => verifySignerFiles(wasm, runtime, manifest)).not.toThrow()
  })

  it('rejects a wasm that does not match the manifest', () => {
    expect(() => verifySignerFiles(tampered(wasm), runtime, manifest)).toThrow(
      'main.wasm does not match the sha256 in main.manifest.json',
    )
  })

  it('rejects a wasm_exec.js that does not match the manifest', () => {
    expect(() => verifySignerFiles(wasm, tampered(runtime), manifest)).toThrow(
      'wasm_exec.js does not match the runtimeSha256 in main.manifest.json',
    )
  })

  it('rejects another signer protocol', () => {
    expect(() => verifySignerFiles(wasm, runtime, { ...manifest, protocol: 3 })).toThrow(
      'Signer wasm protocol 3 is not supported, expected 2',
    )
  })
})

describe('main.manifest.json', () => {
  it('pins a signer with the export the server verifies commands with', () => {
    const { exports } = JSON.parse(
      readFileSync(join(import.meta.dirname, 'web-wasm', 'main.manifest.json'), 'utf8'),
    ) as {
      exports: string[]
    }
    expect(exports).toContain('_verifyStrategyServerCommand')
  })
})

describe('initServerWasm', () => {
  const clock = { now: () => Date.now(), setTimeout, clearTimeout }

  it('reads the signer files again after a failed load', async () => {
    mocks.readFile.mockRejectedValue(new Error('ENOENT'))

    await expect(initServerWasm(clock)).rejects.toThrow('ENOENT')
    expect(mocks.readFile).toHaveBeenCalledTimes(3)
    await expect(initServerWasm(clock)).rejects.toThrow('ENOENT')
    expect(mocks.readFile).toHaveBeenCalledTimes(6)
  })

  it('reports a failed load once, and not again while it fails the same way', async () => {
    const failedLoad = async () => {
      const reasons = await Promise.allSettled([initServerWasm(clock), initServerWasm(clock)])
      return reasons.map((result) => (result as PromiseRejectedResult).reason as unknown)
    }
    mocks.readFile.mockRejectedValue(new Error('EACCES'))

    const [first, shared] = await failedLoad()
    expect(shared).toBe(first)
    expect(shouldReportSignerError(first)).toBe(true)
    expect(shouldReportSignerError(shared)).toBe(false)
    const [repeated] = await failedLoad()
    expect((repeated as Error).message).toBe('EACCES')
    expect(shouldReportSignerError(repeated)).toBe(false)

    mocks.readFile.mockRejectedValue(new Error('EIO'))
    const [changed] = await failedLoad()
    expect(shouldReportSignerError(changed)).toBe(true)
    expect(shouldReportSignerError(new Error('EIO'))).toBe(true)
  })
})
