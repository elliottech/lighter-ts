import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { Clock } from '../engine/types'
import type { GoConstructor, WasmExports } from '../../transactions'
import type { ApiPublicKey } from './backendApiKey'
import { formatUnknownError } from '../engine/errors'

// Copied next to the bundle by build-strategies-server.mjs.
const SIGNER_DIR = fileURLToPath(new URL('web-wasm', import.meta.url))

export const WASM_READY_TIMEOUT_MS = 10_000
const WASM_READY_POLL_MS = 10
const SIGNER_PROTOCOL = 2

type SignerManifest = { protocol: number; sha256: string; runtimeSha256: string }

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

export const verifySignerFiles = (
  wasm: Uint8Array,
  runtime: Uint8Array,
  manifest: SignerManifest,
): void => {
  if (manifest.protocol !== SIGNER_PROTOCOL) {
    throw new Error(
      `Signer wasm protocol ${manifest.protocol} is not supported, expected ${SIGNER_PROTOCOL}`,
    )
  }
  if (sha256(wasm) !== manifest.sha256) {
    throw new Error('main.wasm does not match the sha256 in main.manifest.json')
  }
  if (sha256(runtime) !== manifest.runtimeSha256) {
    throw new Error('wasm_exec.js does not match the runtimeSha256 in main.manifest.json')
  }
}

const wasmGlobal = globalThis as typeof globalThis & WasmExports & { Go: GoConstructor }

let initialized: Promise<void> | null = null

const waitForExports = (clock: Clock): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = clock.now() + WASM_READY_TIMEOUT_MS
    const check = () => {
      if (typeof wasmGlobal._createClient === 'function') resolve()
      else if (clock.now() >= deadline) reject(new Error('Signer wasm initialization timed out'))
      else clock.setTimeout(check, WASM_READY_POLL_MS)
    }
    check()
  })

let running: Promise<void> | null = null

const runWasm = (): Promise<void> => {
  running ??= (async () => {
    const dir = SIGNER_DIR
    const runtimePath = join(dir, 'wasm_exec.js')
    const [wasm, runtime, manifest] = await Promise.all([
      readFile(join(dir, 'main.wasm')),
      readFile(runtimePath),
      readFile(join(dir, 'main.manifest.json'), 'utf8'),
    ])
    verifySignerFiles(wasm, runtime, JSON.parse(manifest) as SignerManifest)
    await import(pathToFileURL(runtimePath).href)
    const go = new wasmGlobal.Go()
    const { instance } = await WebAssembly.instantiate(wasm, go.importObject)
    void go.run(instance)
  })().catch((error: unknown) => {
    running = null
    throw error
  })
  return running
}

/** A failed signer load. Every call that shared the attempt rejects with the same one. */
export class SignerLoadError extends Error {
  reported = false

  constructor(
    cause: unknown,
    /** Whether the attempt before this one failed with the same message. */
    readonly repeatsLast: boolean,
  ) {
    super(formatUnknownError(cause), { cause })
    this.name = 'SignerLoadError'
  }
}

let lastLoadError: string | null = null

/** False for a signer load failure already reported, or one repeating the failure before it. */
export const shouldReportSignerError = (error: unknown): boolean => {
  if (!(error instanceof SignerLoadError)) return true
  if (error.reported || error.repeatsLast) return false
  error.reported = true
  return true
}

/** Loads `web-wasm/main.wasm` with the `wasm_exec.js` and `main.manifest.json` next to it.
 *  A failed load is tried again on the next call; a wasm already running is not started twice. */
export const initServerWasm = (clock: Clock): Promise<void> => {
  initialized ??= (async () => {
    await runWasm()
    await waitForExports(clock)
  })().then(
    () => {
      lastLoadError = null
    },
    (error: unknown) => {
      initialized = null
      const message = formatUnknownError(error)
      const repeatsLast = message === lastLoadError
      lastLoadError = message
      throw new SignerLoadError(error, repeatsLast)
    },
  )
  return initialized
}

/** The loaded signer's exports; call `initServerWasm` first. */
export const getServerWasm = (): WasmExports => wasmGlobal

export const waitForServerWasm = (): Promise<void> =>
  initialized ?? Promise.reject(new Error('Signer wasm is not initialised'))

/** Whether `signature` is the key's `signStrategyServerCommand` of `payload`; loads the wasm on first use. */
export const verifyServerCommandSignature = async (
  clock: Clock,
  { keyType, publicKey }: ApiPublicKey,
  payload: string,
  signature: string,
): Promise<boolean> => {
  await initServerWasm(clock)
  const call = await wasmGlobal._verifyStrategyServerCommand(keyType, publicKey, payload, signature)
  const result = await call()
  return 'valid' in result && result.valid
}
