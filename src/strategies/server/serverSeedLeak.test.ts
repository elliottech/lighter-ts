import { expect, it } from 'vitest'
import { FakeClock } from '../engine/testUtils'
import { captureWorkerException, configureWorkerExceptions } from '../worker/captureWorkerException'
import type { MainToWorker, WorkerToMain } from '../worker/protocol'
import type { StrategiesServerError, StrategiesServerRegistration } from '../wsProtocol'
import type { PendingSigner, StoredSigner } from './serverDb'
import { createServerErrors } from './serverErrors'
import { type WorkerProcessHandlers, createWorkerSupervisor } from './workerSupervisor'

const STORED_SEED = '5eed'.repeat(20)
const REGISTERED_SEED = 'beef'.repeat(20)
const START = {
  kind: 'start',
  id: 'next',
  strategyKind: 'iceberg',
  config: {},
  createdAt: 0,
} as unknown as MainToWorker

it('never puts a seed in the registration, the stored errors or the log lines', async () => {
  const clock = new FakeClock()
  let signer: StoredSigner | null = { seed: STORED_SEED, accountIndex: 7, apiKeyIndex: 4 }
  let pending: PendingSigner | null = null
  const stored: StrategiesServerError[] = []
  const lines: string[] = []
  const errors = createServerErrors({
    db: {
      saveError: (error) => {
        const next = { ...error, id: stored.length + 1 }
        stored.push(next)
        return next
      },
      readUnackedErrors: () => ({ errors: stored, skippedErrorsCount: 0 }),
      ackErrors: () => {},
    },
    clock,
    version: '1.0.0',
    maxMessageLength: 1000,
    maxStackLength: 8000,
    onStoreError: (error) => {
      throw error
    },
  })
  // As in server.main.ts: each output line is also stored when it carries an error.
  const writeOutput = (message: WorkerToMain) => {
    errors.record(message)
    lines.push(JSON.stringify(message))
  }
  configureWorkerExceptions(writeOutput)
  const workers: WorkerProcessHandlers[] = []
  const supervisor = createWorkerSupervisor({
    db: {
      readSigner: () => signer,
      readPendingSigner: () => pending,
      savePendingSigner: (next) => {
        pending = next
      },
      adoptPendingSigner: () => {
        if (!pending) return null
        const { createdAt: _createdAt, ...adopted } = pending
        signer = adopted
        pending = null
        return adopted
      },
      readPendingStops: () => [],
      savePendingStop: () => {},
      deletePendingStop: () => {},
    },
    chainId: 304,
    apiKeyIndex: 4,
    isPoolAccount: false,
    clock,
    persistedStrategies: {},
    spawnWorker: (handlers) => {
      workers.push(handlers)
      return { send: () => {}, kill: () => Promise.resolve() }
    },
    getPublicKey: () => Promise.resolve(null),
    onWorkerMessage: writeOutput,
    onError: (error) =>
      captureWorkerException(error, { tags: { feature: 'strategies-server-worker' } }),
  })
  const shown: (StrategiesServerRegistration | null)[] = []
  supervisor.subscribeRegistration((registration) => shown.push(registration))

  const first = workers[0]
  first?.onMessage({ kind: 'signerFailed', error: 'key revoked' })
  first?.onMessage({
    kind: 'registration',
    registration: {
      accountIndex: 7,
      apiKeyIndex: 4,
      publicKey: 'ab'.repeat(40),
      nonce: 3,
      expiredAt: 600_000,
      txInfo: '{}',
      seed: REGISTERED_SEED,
    },
  })
  first?.onMessage({ kind: 'initFailed', error: 'key revoked' })
  first?.onMessage({
    kind: 'event',
    id: 'a',
    event: { type: 'sentry', error: new Error('order rejected'), tags: {} },
  })
  first?.onExit(1)
  shown.push(supervisor.getRegistration())
  await supervisor.send(START)
  workers[1]?.onMessage({ kind: 'initialised' })

  expect(signer?.seed).toBe(REGISTERED_SEED)
  expect(shown).toHaveLength(2)
  expect(stored.length).toBeGreaterThanOrEqual(3)
  expect(lines.length).toBeGreaterThanOrEqual(4)
  const output = [JSON.stringify(shown), JSON.stringify(stored), ...lines].join('\n')
  expect(output).not.toContain(STORED_SEED)
  expect(output).not.toContain(REGISTERED_SEED)
})
