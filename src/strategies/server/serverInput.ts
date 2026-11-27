import type { StrategyKind } from '../engine/types'
import type { MainToWorker } from '../worker/protocol'
import type { ServerWorkerAuthMessage } from './serverProtocol'
import type {
  StrategiesServerAckErrors,
  StrategiesServerCommand,
  StrategiesServerDownloadLogs,
  StrategiesServerLogsSize,
  StrategiesServerSignedFrame,
  StrategiesServerSignedPayload,
  StrategiesServerUpdate,
} from '../wsProtocol'

const STRATEGY_KINDS: readonly StrategyKind[] = ['advanced-twap', 'chase-limit', 'iceberg']
export const MAX_API_KEY_INDEX = 254
// A semver version, which also makes it safe as a directory name.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/
const MAX_VERSION_LENGTH = 200
const MAX_DOWNLOAD_ID_LENGTH = 200
const MAX_CHALLENGE_LENGTH = 200
/** About 8x the largest frame a client sends today: a start with its record. */
export const MAX_CLIENT_FRAME_BYTES = 16 * 1024
const SIGNATURE_PATTERN = /^(0x)?[0-9a-f]{1,400}$/i
const LOGS_SIZES: readonly StrategiesServerLogsSize[] = ['small', 'large']

export const isServerVersion = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(value)

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isIndex = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max

const parseObject = (line: string): Record<string, unknown> => {
  const msg: unknown = JSON.parse(line)
  if (!isObject(msg)) throw new Error('Input must be a JSON object')
  return msg
}

const unknownKind = (msg: Record<string, unknown>) =>
  new Error(`Unknown input kind ${JSON.stringify(msg.kind)}`)

const parseWorkerCommand = (msg: Record<string, unknown>): MainToWorker | null => {
  if (msg.kind === 'refreshTier') return { kind: 'refreshTier' }
  if (msg.kind !== 'start' && msg.kind !== 'stop' && msg.kind !== 'remove') return null
  if (typeof msg.id !== 'string' || !msg.id) throw new Error('Input id must be a non-empty string')
  switch (msg.kind) {
    case 'start':
      if (!STRATEGY_KINDS.includes(msg.strategyKind as StrategyKind)) {
        throw new Error(`Unknown strategyKind ${JSON.stringify(msg.strategyKind)}`)
      }
      if (!isObject(msg.config)) throw new Error('start config must be an object')
      if (!Number.isFinite(msg.createdAt)) throw new Error('start createdAt must be a number')
      if (msg.resume !== undefined && !isObject(msg.resume)) {
        throw new Error('start resume must be an object')
      }
      if (msg.record !== undefined && !isObject(msg.record)) {
        throw new Error('start record must be an object')
      }
      return msg as MainToWorker
    case 'stop':
      if (msg.reason !== undefined && typeof msg.reason !== 'string') {
        throw new Error('stop reason must be a string')
      }
      return msg as MainToWorker
    case 'remove':
      return msg as MainToWorker
  }
}

const parseUpdate = (msg: Record<string, unknown>): StrategiesServerUpdate => {
  if (!isServerVersion(msg.version)) throw new Error('update version must be a semver version')
  return { kind: 'update', version: msg.version }
}

const parseAckErrors = (msg: Record<string, unknown>): StrategiesServerAckErrors => {
  if (!isIndex(msg.lastErrorId, Number.MAX_SAFE_INTEGER)) {
    throw new Error('ackErrors lastErrorId must be a non-negative integer')
  }
  return { kind: 'ackErrors', lastErrorId: msg.lastErrorId }
}

const parseDownloadLogs = (msg: Record<string, unknown>): StrategiesServerDownloadLogs => {
  if (typeof msg.id !== 'string' || !msg.id || msg.id.length > MAX_DOWNLOAD_ID_LENGTH) {
    throw new Error(
      `downloadLogs id must be a non-empty string of at most ${MAX_DOWNLOAD_ID_LENGTH} characters`,
    )
  }
  if (!LOGS_SIZES.includes(msg.size as StrategiesServerLogsSize)) {
    throw new Error(`downloadLogs size must be one of ${LOGS_SIZES.join(', ')}`)
  }
  return { kind: 'downloadLogs', id: msg.id, size: msg.size as StrategiesServerLogsSize }
}

const parseClientCommand = (msg: Record<string, unknown>): StrategiesServerCommand => {
  if (msg.kind === 'ackErrors') return parseAckErrors(msg)
  if (msg.kind === 'downloadLogs') return parseDownloadLogs(msg)
  // The worker resumes from its own store; a client resume would skip the checks of a new start.
  if (msg.kind === 'start' && msg.resume !== undefined) {
    throw new Error('start resume is not accepted from a websocket client')
  }
  return parseCommand(msg)
}

const parseCommand = (msg: Record<string, unknown>): MainToWorker | StrategiesServerUpdate => {
  if (msg.kind === 'update') return parseUpdate(msg)
  const command = parseWorkerCommand(msg)
  if (!command) throw unknownKind(msg)
  return command
}

/** Parses one stdin line of the server; throws on anything but start, stop, remove, refreshTier or update. */
export const parseServerInput = (line: string): MainToWorker | StrategiesServerUpdate =>
  parseCommand(parseObject(line))

export interface StrategiesServerClientFrame
  extends StrategiesServerSignedFrame,
    StrategiesServerSignedPayload {}

/** Parses one websocket message: a signed frame and the payload it signs. `strategiesWsServer` checks the signature. */
export const parseClientInput = (line: string): StrategiesServerClientFrame => {
  const { payload, signature } = parseObject(line)
  if (typeof payload !== 'string') throw new Error('Frame payload must be a string')
  if (payload.length > MAX_CLIENT_FRAME_BYTES) {
    throw new Error(`Frame payload must be at most ${MAX_CLIENT_FRAME_BYTES} characters`)
  }
  if (typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
    throw new Error('Frame signature must be hex')
  }
  const { challenge, seq, accountIndex, apiKeyIndex, command } = parseObject(payload)
  if (typeof challenge !== 'string' || !challenge || challenge.length > MAX_CHALLENGE_LENGTH) {
    throw new Error(
      `Payload challenge must be a non-empty string of at most ${MAX_CHALLENGE_LENGTH} characters`,
    )
  }
  if (!isIndex(seq, Number.MAX_SAFE_INTEGER)) {
    throw new Error('Payload seq must be a non-negative integer')
  }
  if (!isIndex(accountIndex, Number.MAX_SAFE_INTEGER)) {
    throw new Error('Payload accountIndex must be a non-negative integer')
  }
  if (!isIndex(apiKeyIndex, MAX_API_KEY_INDEX)) {
    throw new Error(`Payload apiKeyIndex must be an integer from 0 to ${MAX_API_KEY_INDEX}`)
  }
  if (!isObject(command)) throw new Error('Payload command must be an object')
  return {
    payload,
    signature,
    challenge,
    seq,
    accountIndex,
    apiKeyIndex,
    command: command.kind === 'hello' ? { kind: 'hello' } : parseClientCommand(command),
  }
}

/** Parses one stdin line of the worker process, which only the server writes to. */
export const parseWorkerInput = (line: string): MainToWorker | ServerWorkerAuthMessage => {
  const msg = parseObject(line)
  if (msg.kind === 'authenticate') {
    if (msg.signer !== null && !isObject(msg.signer)) {
      throw new Error('authenticate signer must be an object or null')
    }
    if (typeof msg.isPoolAccount !== 'boolean') {
      throw new Error('authenticate isPoolAccount must be a boolean')
    }
    const registration = msg.registration
    if (!isObject(registration)) throw new Error('authenticate registration must be an object')
    if (!isIndex(registration.accountIndex, Number.MAX_SAFE_INTEGER)) {
      throw new Error('authenticate registration accountIndex must be a non-negative integer')
    }
    if (!isIndex(registration.apiKeyIndex, MAX_API_KEY_INDEX)) {
      throw new Error(
        `authenticate registration apiKeyIndex must be an integer from 0 to ${MAX_API_KEY_INDEX}`,
      )
    }
    if (!isIndex(registration.chainId, Number.MAX_SAFE_INTEGER)) {
      throw new Error('authenticate registration chainId must be a non-negative integer')
    }
    if (registration.seed !== null && typeof registration.seed !== 'string') {
      throw new Error('authenticate registration seed must be a string or null')
    }
    return msg as ServerWorkerAuthMessage
  }
  const command = parseWorkerCommand(msg)
  if (!command) throw unknownKind(msg)
  return command
}
