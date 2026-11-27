import { describe, expect, it } from 'vitest'
import {
  MAX_CLIENT_FRAME_BYTES,
  parseClientInput,
  parseServerInput,
  parseWorkerInput,
} from './serverInput'

const start = {
  kind: 'start',
  id: 'chase-1',
  strategyKind: 'chase-limit',
  config: { accountIndex: 7, marketId: 1 },
  createdAt: 0,
}

const parse = (msg: unknown) => () => parseServerInput(JSON.stringify(msg))

describe('parseServerInput', () => {
  it('accepts start, stop and remove messages', () => {
    expect(parseServerInput(JSON.stringify(start))).toEqual(start)
    expect(parse({ kind: 'stop', id: 'chase-1', reason: 'user' })()).toEqual({
      kind: 'stop',
      id: 'chase-1',
      reason: 'user',
    })
    expect(parse({ kind: 'remove', id: 'chase-1' })()).toEqual({ kind: 'remove', id: 'chase-1' })
  })

  it('accepts a refreshTier without an id, dropping extra fields', () => {
    expect(parse({ kind: 'refreshTier', id: 1 })()).toEqual({ kind: 'refreshTier' })
    expect(parseWorkerInput(JSON.stringify({ kind: 'refreshTier' }))).toEqual({
      kind: 'refreshTier',
    })
  })

  it('rejects invalid JSON and non-objects', () => {
    expect(() => parseServerInput('{')).toThrow(SyntaxError)
    expect(parse([start])).toThrow('Input must be a JSON object')
    expect(parse(null)).toThrow('Input must be a JSON object')
  })

  it('rejects a missing or empty id', () => {
    expect(parse({ ...start, id: undefined })).toThrow('Input id must be a non-empty string')
    expect(parse({ ...start, id: '' })).toThrow('Input id must be a non-empty string')
    expect(parse({ kind: 'stop', id: 1 })).toThrow('Input id must be a non-empty string')
  })

  it('rejects unknown kinds', () => {
    expect(parse({ kind: 'authenticate', id: 'x' })).toThrow('Unknown input kind "authenticate"')
    expect(parse({ ...start, strategyKind: 'twap' })).toThrow('Unknown strategyKind "twap"')
  })

  it('rejects a start without a config object or createdAt', () => {
    expect(parse({ kind: 'start', id: 'chase-1', strategyKind: 'chase-limit' })).toThrow(
      'start config must be an object',
    )
    expect(parse({ ...start, config: [] })).toThrow('start config must be an object')
    expect(parse({ ...start, createdAt: '0' })).toThrow('start createdAt must be a number')
    expect(parse({ ...start, resume: 1 })).toThrow('start resume must be an object')
    expect(parse({ ...start, record: 'x' })).toThrow('start record must be an object')
  })

  it('rejects a non-string stop reason', () => {
    expect(parse({ kind: 'stop', id: 'chase-1', reason: 1 })).toThrow(
      'stop reason must be a string',
    )
  })

  it('rejects an auth: the server registers a key of its own', () => {
    expect(parse({ kind: 'auth', seed: 'abcd', accountIndex: 7, apiKeyIndex: 3 })).toThrow(
      'Unknown input kind "auth"',
    )
  })

  it('accepts an update to a release or a pre-release version', () => {
    expect(parse({ kind: 'update', version: '1.0.49', extra: 1 })()).toEqual({
      kind: 'update',
      version: '1.0.49',
    })
    const prerelease = '0.1458.0-author.1b4644ae.strategies-ws-server'
    expect(parse({ kind: 'update', version: prerelease })()).toEqual({
      kind: 'update',
      version: prerelease,
    })
  })

  it('rejects an update whose version is not semver', () => {
    for (const version of [undefined, 1, '', 'latest', '1.0', '../1.0.0', '1.0.0/x', '1.0.0-']) {
      expect(parse({ kind: 'update', version })).toThrow('update version must be a semver version')
    }
  })
})

const SIGNATURE = 'ab'.repeat(40)

const frameOf = (
  command: unknown,
  payload: Record<string, unknown> = {},
  signature: unknown = SIGNATURE,
) =>
  JSON.stringify({
    payload: JSON.stringify({
      challenge: 'c1',
      seq: 1,
      accountIndex: 7,
      apiKeyIndex: 3,
      command,
      ...payload,
    }),
    signature,
  })

describe('parseClientInput', () => {
  it('parses a signed frame and keeps the exact payload it signs', () => {
    const line = frameOf(start)
    expect(parseClientInput(line)).toEqual({
      payload: (JSON.parse(line) as { payload: string }).payload,
      signature: SIGNATURE,
      challenge: 'c1',
      seq: 1,
      accountIndex: 7,
      apiKeyIndex: 3,
      command: start,
    })
  })

  it('parses a hello without its extra fields', () => {
    expect(parseClientInput(frameOf({ kind: 'hello', extra: 1 })).command).toEqual({
      kind: 'hello',
    })
  })

  it('rejects a frame without a payload string or a hex signature', () => {
    expect(() => parseClientInput(JSON.stringify(start))).toThrow('Frame payload must be a string')
    for (const signature of [null, 7, '', 'xyz', 'ab'.repeat(201)]) {
      expect(() => parseClientInput(frameOf(start, {}, signature))).toThrow(
        'Frame signature must be hex',
      )
    }
    expect(() =>
      parseClientInput(JSON.stringify({ payload: 'not json', signature: SIGNATURE })),
    ).toThrow()
  })

  it.each([
    [{ challenge: '' }, 'Payload challenge must be a non-empty string'],
    [{ challenge: 'c'.repeat(201) }, 'Payload challenge must be a non-empty string'],
    [{ seq: -1 }, 'Payload seq must be a non-negative integer'],
    [{ seq: 1.5 }, 'Payload seq must be a non-negative integer'],
    [{ accountIndex: '7' }, 'Payload accountIndex must be a non-negative integer'],
    [{ apiKeyIndex: 255 }, 'Payload apiKeyIndex must be an integer from 0 to 254'],
    [{ command: 'start' }, 'Payload command must be an object'],
  ])('rejects a payload with %j', (payload, error) => {
    expect(() => parseClientInput(frameOf(start, payload))).toThrow(error)
  })

  it('rejects a registered hint and an auth', () => {
    expect(() => parseClientInput(frameOf({ kind: 'registered' }))).toThrow(
      'Unknown input kind "registered"',
    )
    const auth = { kind: 'auth', seed: 'abcd', accountIndex: 7, apiKeyIndex: 3 }
    expect(() => parseClientInput(frameOf(auth))).toThrow('Unknown input kind "auth"')
  })

  it('parses an ackErrors, which parseServerInput rejects', () => {
    const ack = { kind: 'ackErrors', lastErrorId: 12 }
    expect(parseClientInput(frameOf({ ...ack, extra: 1 })).command).toEqual(ack)
    for (const lastErrorId of [-1, 1.5, '12', undefined]) {
      expect(() => parseClientInput(frameOf({ kind: 'ackErrors', lastErrorId }))).toThrow(
        'ackErrors lastErrorId must be a non-negative integer',
      )
    }
    expect(parse(ack)).toThrow('Unknown input kind "ackErrors"')
  })

  it('parses a downloadLogs, which parseServerInput rejects', () => {
    const download = { kind: 'downloadLogs', id: 'd1', size: 'small' }
    expect(parseClientInput(frameOf({ ...download, extra: 1 })).command).toEqual(download)
    for (const size of ['medium', undefined, 1]) {
      expect(() => parseClientInput(frameOf({ ...download, size }))).toThrow(
        'downloadLogs size must be one of small, large',
      )
    }
    for (const id of ['', 'x'.repeat(201), 7, undefined]) {
      expect(() => parseClientInput(frameOf({ ...download, id }))).toThrow(
        'downloadLogs id must be a non-empty string',
      )
    }
    expect(parse(download)).toThrow('Unknown input kind "downloadLogs"')
  })

  it('rejects a start with a resume, which parseServerInput and parseWorkerInput accept', () => {
    for (const resume of [{}, { filledBaseAmount: 1, workingOrders: { '7': {} } }, null]) {
      expect(() => parseClientInput(frameOf({ ...start, resume }))).toThrow(
        'start resume is not accepted from a websocket client',
      )
    }
    const resumed = { ...start, resume: { workingOrders: {} } }
    expect(parseServerInput(JSON.stringify(resumed))).toEqual(resumed)
    expect(parseWorkerInput(JSON.stringify(resumed))).toEqual(resumed)
  })

  it('rejects a payload longer than the frame limit before parsing it', () => {
    const payload = 'x'.repeat(MAX_CLIENT_FRAME_BYTES + 1)
    expect(() => parseClientInput(JSON.stringify({ payload, signature: SIGNATURE }))).toThrow(
      `Frame payload must be at most ${MAX_CLIENT_FRAME_BYTES} characters`,
    )
  })

  it('rejects what parseServerInput rejects', () => {
    expect(() => parseClientInput(frameOf({ kind: 'stop' }))).toThrow(
      'Input id must be a non-empty string',
    )
  })
})

describe('parseWorkerInput', () => {
  const authenticate = {
    kind: 'authenticate',
    signer: { seed: 'abcd', accountIndex: 7, apiKeyIndex: 3, chainId: 304 },
    isPoolAccount: false,
    registration: { accountIndex: 7, apiKeyIndex: 4, chainId: 304, seed: null },
  }

  it('accepts authenticate and the worker commands', () => {
    expect(parseWorkerInput(JSON.stringify(authenticate))).toEqual(authenticate)
    expect(parseWorkerInput(JSON.stringify({ ...authenticate, signer: null }))).toEqual({
      ...authenticate,
      signer: null,
    })
    expect(parseWorkerInput(JSON.stringify(start))).toEqual(start)
  })

  it('rejects auth and malformed authenticate messages', () => {
    const worker = (msg: unknown) => () => parseWorkerInput(JSON.stringify(msg))
    expect(worker({ kind: 'auth', seed: 'abcd', accountIndex: 7, apiKeyIndex: 3 })).toThrow(
      'Unknown input kind "auth"',
    )
    expect(worker({ ...authenticate, signer: 'abcd' })).toThrow(
      'authenticate signer must be an object or null',
    )
    expect(worker({ ...authenticate, isPoolAccount: 'false' })).toThrow(
      'authenticate isPoolAccount must be a boolean',
    )
    const registration = authenticate.registration
    for (const [value, error] of [
      [undefined, 'authenticate registration must be an object'],
      [{ ...registration, accountIndex: -1 }, 'authenticate registration accountIndex must be'],
      [{ ...registration, apiKeyIndex: 255 }, 'authenticate registration apiKeyIndex must be'],
      [{ ...registration, chainId: '304' }, 'authenticate registration chainId must be'],
      [{ ...registration, seed: 1 }, 'authenticate registration seed must be a string or null'],
    ] as const) {
      expect(worker({ ...authenticate, registration: value })).toThrow(error)
    }
  })
})
