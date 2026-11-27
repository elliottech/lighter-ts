import { randomBytes } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { type AddressInfo, type Socket } from 'node:net'
import { type WebSocket, WebSocketServer } from 'ws'
import type { Clock, StrategyRecord } from '../engine/types'
import type { MainToWorker } from '../worker/protocol'
import type { ApiPublicKey } from './backendApiKey'
import type { UnackedErrors } from './serverDb'
import {
  MAX_CLIENT_FRAME_BYTES,
  type StrategiesServerClientFrame,
  parseClientInput,
} from './serverInput'
import { STRATEGIES_WS_MAX_SENT_ERRORS } from './serverErrors'
import type { ServerLogs } from './serverLogs'
import type { TlsCertificate } from './serverTls'
import type {
  StrategiesServerCommand,
  StrategiesServerDownloadLogs,
  StrategiesServerError,
  StrategiesServerLogsSize,
  StrategiesServerMessage,
  StrategiesServerPlatform,
  StrategiesServerRegistration,
  StrategiesServerSignerStatus,
} from '../wsProtocol'

export const STRATEGIES_WS_UPDATE_INTERVAL_MS = 1000
/** Application close code sent after an `unauthenticated` message. */
export const STRATEGIES_WS_UNAUTHENTICATED_CLOSE_CODE = 4401
/** Close code (Try Again Later) when the hello signature could not be checked. */
export const STRATEGIES_WS_RETRY_CLOSE_CODE = 1013
/** HTTP status of a handshake rejected for its `Origin`. */
export const STRATEGIES_WS_FORBIDDEN_ORIGIN_STATUS = 403
export const STRATEGIES_WS_NO_WORKER_ERROR =
  'The strategies server has no worker running, try again'
export const STRATEGIES_WS_UNAUTHORIZED_ERROR =
  'The command is not signed by an API key of the account the server signs for'
export const STRATEGIES_WS_AUTH_CHECK_FAILED_ERROR =
  'The command signature could not be checked, try again'
/** A client that sends no valid `hello` within this long gets `unauthenticated`. */
export const STRATEGIES_WS_HELLO_TIMEOUT_MS = 10_000
/** How long a fetched API public key is used before it is fetched again. */
export const STRATEGIES_WS_PUBLIC_KEY_TTL_MS = 60_000
export const STRATEGIES_WS_NO_LOGS_ERROR =
  'Only a server started by the strategies-server launcher keeps logs'
export const STRATEGIES_WS_LOGS_BUSY_ERROR = 'A logs download is already in progress'
export const STRATEGIES_WS_LOGS_FAILED_ERROR = 'The logs could not be read'

type Strategies = Record<string, StrategyRecord>

/** On `ok`, `restart` is called once the answer is sent. */
export type UpdateResult = { ok: true; restart: () => void } | { ok: false; error: string }

export interface StrategiesWsServerOptions {
  host: string
  port: number
  /** Browser origins allowed to connect; a client that sends no `Origin` is not a browser and is allowed. */
  allowedOrigins: readonly string[]
  clock: Clock
  /** The API key indexes a frame may be signed with; a frame signed with any other key is refused. */
  allowedApiKeyIndexes: readonly number[]
  /** The only account a `hello` may sign in with, null for any. */
  allowedAccountIndex: number | null
  /** The version sent in `connected`, null when not run by the launcher. */
  version: string | null
  /** The public key the account registered at the API key index, null when it has none; rejects when it cannot tell. */
  getPublicKey: (accountIndex: number, apiKeyIndex: number) => Promise<ApiPublicKey | null>
  /** Whether `signature` is the key's `signStrategyServerCommand` of `payload`. */
  verifySignature: (key: ApiPublicKey, payload: string, signature: string) => Promise<boolean>
  /** The account the server signs for, null before its first `auth`. */
  getAccountIndex: () => number | null
  getSignerStatus: () => StrategiesServerSignerStatus | null
  subscribeSignerStatus: (listener: (status: StrategiesServerSignerStatus) => void) => () => void
  getRegistration: () => StrategiesServerRegistration | null
  subscribeRegistration: (
    listener: (registration: StrategiesServerRegistration) => void,
  ) => () => void
  /** Called with the account of the first verified client while the server has none. */
  onRegister: (accountIndex: number) => void
  onUpdate: (version: string) => Promise<UpdateResult>
  getPlatform: () => StrategiesServerPlatform
  subscribePlatform: (listener: (platform: StrategiesServerPlatform) => void) => () => void
  /** Whether the command reached a worker, or the error it is rejected with. */
  onCommand: (command: MainToWorker) => Promise<boolean | string>
  getStrategies: () => Strategies
  /** Calls the listener with the new and previous records on every change. */
  subscribeStrategies: (listener: (next: Strategies, previous: Strategies) => void) => () => void
  /** The latest errors not acked yet, by increasing id, sent in `connected`. */
  getErrors: () => UnackedErrors
  /** Calls the listener with every error captured from now on. */
  subscribeErrors: (listener: (error: StrategiesServerError) => void) => () => void
  onAckErrors: (lastErrorId: number) => void
  /** The logs a `downloadLogs` streams, null when the server keeps none. */
  openLogs: (size: StrategiesServerLogsSize) => Promise<ServerLogs | null>
  /** How often each client is pinged. */
  pingIntervalMs: number
  /** A client that answers none of the pings sent over this long is terminated. */
  pongTimeoutMs: number
  onError: (error: unknown) => void
  /** Serves wss:// with this certificate instead of ws://. */
  tls?: TlsCertificate
}

export interface StrategiesWsServer {
  /** Resolves once the server accepts connections. */
  listening: Promise<AddressInfo>
  /** Serves new connections with a renewed certificate; a no-op on ws://. */
  setCertificate: (tls: TlsCertificate) => void
  close: () => Promise<void>
}

interface Connection {
  challenge: string
  /** The `seq` of the last frame accepted on it. */
  seq: number
}

const isSameKey = (a: ApiPublicKey | null, b: ApiPublicKey | null) =>
  a?.keyType === b?.keyType && a?.publicKey === b?.publicKey

const parseFrame = (data: unknown): StrategiesServerClientFrame | null => {
  try {
    return parseClientInput(String(data))
  } catch {
    return null
  }
}

/**
 * Serves the strategy store to frontends over a websocket: a client sends
 * the worker's commands and gets the records, batched once a second. Every
 * frame a client sends is signed by an API key of the account the server
 * signs for, over the connection's challenge. A client whose `hello` fails
 * verification gets `unauthenticated` and is closed; it is never sent a
 * record. While the server has no signer, a `hello` is checked against its
 * own account, which the server then signs for.
 */
export const createStrategiesWsServer = ({
  host,
  port,
  allowedOrigins,
  clock,
  allowedApiKeyIndexes,
  allowedAccountIndex,
  version,
  getPublicKey,
  verifySignature,
  getAccountIndex,
  getSignerStatus,
  subscribeSignerStatus,
  getRegistration,
  subscribeRegistration,
  onRegister,
  onUpdate,
  getPlatform,
  subscribePlatform,
  onCommand,
  getStrategies,
  subscribeStrategies,
  getErrors,
  subscribeErrors,
  onAckErrors,
  openLogs,
  pingIntervalMs,
  pongTimeoutMs,
  onError,
  tls,
}: StrategiesWsServerOptions): StrategiesWsServer => {
  const origins = new Set(allowedOrigins)
  const apiKeyIndexes = new Set(allowedApiKeyIndexes)
  // ws answers plain requests with 426 only on a server it creates itself.
  const httpsServer = tls
    ? createHttpsServer(tls, (_, response) => {
        response.writeHead(426, { 'content-type': 'text/plain' }).end(STATUS_CODES[426])
      })
    : null
  // A connection still in its TLS handshake or its request would hold up httpsServer.close.
  const httpsSockets = new Set<Socket>()
  httpsServer?.on('connection', (socket: Socket) => {
    httpsSockets.add(socket)
    socket.once('close', () => httpsSockets.delete(socket))
  })
  const server = new WebSocketServer({
    ...(httpsServer ? { server: httpsServer } : { host, port }),
    // Larger frames close with 1009 before they are parsed or hashed.
    maxPayload: MAX_CLIENT_FRAME_BYTES,
    verifyClient: ({ req }, done) => {
      const origin = req.headers.origin
      if (origin === undefined || origins.has(origin)) done(true)
      else done(false, STRATEGIES_WS_FORBIDDEN_ORIGIN_STATUS, 'Origin not allowed')
    },
  })
  const authenticated = new Set<WebSocket>()
  const changed = new Map<string, StrategyRecord | null>()
  // The id of the last error each socket was sent.
  const sentErrorIds = new Map<WebSocket, number>()
  let newErrors: StrategiesServerError[] = []
  let skippedErrorsCount = 0
  let leader: WebSocket | null = null
  const missedPongs = new Map<WebSocket, number>()
  const maxMissedPongs = Math.ceil(pongTimeoutMs / pingIntervalMs)
  let downloading = false
  const publicKeys = new Map<
    string,
    { publicKey: ApiPublicKey | null; fetchedAt: number; request: number }
  >()
  let keyRequests = 0
  const refreshingKeys = new Set<string>()
  const helloTimers = new Map<WebSocket, number>()
  let flushTimer: number | null = null
  let pingTimer: number | null = null
  let closed = false

  const send = (socket: WebSocket, message: StrategiesServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  const flushErrors = () => {
    if (newErrors.length === 0) return
    const errors = newErrors
    const skipped = skippedErrorsCount
    newErrors = []
    skippedErrorsCount = 0
    for (const socket of authenticated) {
      const sentId = sentErrorIds.get(socket) ?? 0
      const unsent = errors.filter(({ id }) => id > sentId)
      const last = unsent.at(-1)
      if (!last) continue
      sentErrorIds.set(socket, last.id)
      send(socket, { kind: 'errors', errors: unsent, skippedErrorsCount: skipped })
    }
  }

  const flush = () => {
    flushTimer = null
    if (closed) return
    flushTimer = clock.setTimeout(flush, STRATEGIES_WS_UPDATE_INTERVAL_MS)
    flushErrors()
    if (changed.size === 0 || authenticated.size === 0) {
      changed.clear()
      return
    }
    const message: StrategiesServerMessage = { kind: 'updated', strategies: [], removed: [] }
    for (const [id, record] of changed) {
      if (record) message.strategies.push(record)
      else message.removed.push(id)
    }
    changed.clear()
    for (const socket of authenticated) send(socket, message)
  }

  const unsubscribeSignerStatus = subscribeSignerStatus((status) => {
    for (const socket of authenticated) send(socket, { kind: 'signer', status })
  })

  const unsubscribeRegistration = subscribeRegistration((registration) => {
    for (const socket of authenticated) send(socket, { kind: 'authRequired', registration })
  })

  const unsubscribePlatform = subscribePlatform((platform) => {
    for (const socket of authenticated) send(socket, { kind: 'platform', ...platform })
  })

  const unsubscribeErrors = subscribeErrors((error) => {
    if (authenticated.size === 0) return
    newErrors.push(error)
    if (newErrors.length <= STRATEGIES_WS_MAX_SENT_ERRORS) return
    newErrors.shift()
    skippedErrorsCount++
  })

  const unsubscribe = subscribeStrategies((next, previous) => {
    for (const id of Object.keys(previous)) {
      if (!(id in next)) changed.set(id, null)
    }
    for (const [id, record] of Object.entries(next)) {
      if (previous[id] !== record) changed.set(id, record)
    }
  })

  const reject = (socket: WebSocket) => {
    send(socket, { kind: 'unauthenticated' })
    socket.close(STRATEGIES_WS_UNAUTHENTICATED_CLOSE_CODE, 'unauthenticated')
  }

  const answerUpdate = async (socket: WebSocket, version: string) => {
    let result: UpdateResult
    try {
      result = await onUpdate(version)
    } catch (error) {
      onError(error)
      result = { ok: false, error: 'update failed' }
    }
    if (!result.ok) {
      send(socket, { kind: 'updateResult', ok: false, error: result.error })
      return
    }
    await new Promise<void>((resolve) => {
      if (socket.readyState !== socket.OPEN) resolve()
      else socket.send(JSON.stringify({ kind: 'updateResult', ok: true }), () => resolve())
    })
    result.restart()
  }

  const readErrors = (): UnackedErrors => {
    try {
      return getErrors()
    } catch {
      try {
        return getErrors()
      } catch (error) {
        onError(error)
        return { errors: [], skippedErrorsCount: 0 }
      }
    }
  }

  const promote = () => {
    for (const socket of authenticated) {
      if (socket.readyState !== socket.OPEN) continue
      leader = socket
      const { errors, skippedErrorsCount } = readErrors()
      const sentId = sentErrorIds.get(socket) ?? 0
      sentErrorIds.set(socket, Math.max(sentId, errors.at(-1)?.id ?? 0))
      send(socket, { kind: 'leaderUpdate', errors, skippedErrorsCount })
      return
    }
  }

  const accept = (socket: WebSocket) => {
    clearHelloTimer(socket)
    authenticated.add(socket)
    const isLeaderConnection = leader === null
    if (isLeaderConnection) leader = socket
    const { errors, skippedErrorsCount } = readErrors()
    sentErrorIds.set(socket, errors.at(-1)?.id ?? 0)
    send(socket, {
      kind: 'connected',
      strategies: Object.values(getStrategies()),
      signer: getSignerStatus() ?? 'starting',
      version,
      platform: getPlatform(),
      errors,
      skippedErrorsCount,
      isLeaderConnection,
    })
    const registration = getRegistration()
    if (registration) send(socket, { kind: 'authRequired', registration })
  }

  const isGone = (socket: WebSocket) => closed || socket.readyState !== socket.OPEN

  const sendBinary = (socket: WebSocket, data: Buffer) =>
    new Promise<void>((resolve, reject) => {
      socket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()))
    })

  const sendLogs = async (socket: WebSocket, { id, size }: StrategiesServerDownloadLogs) => {
    if (downloading) {
      send(socket, { kind: 'logsFailed', id, error: STRATEGIES_WS_LOGS_BUSY_ERROR })
      return
    }
    downloading = true
    let logs: ServerLogs | null = null
    try {
      logs = await openLogs(size)
      if (!logs) {
        send(socket, { kind: 'logsFailed', id, error: STRATEGIES_WS_NO_LOGS_ERROR })
        return
      }
      if (isGone(socket)) return
      send(socket, { kind: 'logs', id, size, bytes: logs.bytes })
      for await (const part of logs.data as AsyncIterable<Buffer>) {
        if (isGone(socket)) return
        await sendBinary(socket, part)
      }
      send(socket, { kind: 'logsEnd', id })
    } catch (error) {
      if (isGone(socket)) return
      onError(error)
      send(socket, { kind: 'logsFailed', id, error: STRATEGIES_WS_LOGS_FAILED_ERROR })
    } finally {
      logs?.data.destroy()
      downloading = false
    }
  }

  const refuse = (socket: WebSocket, command: StrategiesServerCommand, error: string) => {
    if (command.kind === 'update') send(socket, { kind: 'updateResult', ok: false, error })
    else if (command.kind === 'downloadLogs')
      send(socket, { kind: 'logsFailed', id: command.id, error })
    else if (command.kind !== 'refreshTier' && command.kind !== 'ackErrors')
      send(socket, { kind: 'rejected', id: command.id, error })
  }

  const dispatch = (socket: WebSocket, command: StrategiesServerCommand) => {
    if (command.kind === 'update') void answerUpdate(socket, command.version)
    else if (command.kind === 'ackErrors') onAckErrors(command.lastErrorId)
    else if (command.kind === 'downloadLogs') void sendLogs(socket, command)
    else {
      // Without a worker a tier refresh is moot: the next worker loads the tier at init.
      const answer = (result: boolean | string) => {
        if (result === false) refuse(socket, command, STRATEGIES_WS_NO_WORKER_ERROR)
        else if (typeof result === 'string') refuse(socket, command, result)
      }
      void onCommand(command).then(answer, onError)
    }
  }

  const clearHelloTimer = (socket: WebSocket) => {
    const timer = helloTimers.get(socket)
    if (timer === undefined) return
    clock.clearTimeout(timer)
    helloTimers.delete(socket)
  }

  // Resolves to whether an allowed key the account has registered at the frame's index signed it, rejects
  // when the key cannot be fetched. A key is fetched again once it is old or does not match, so a
  // rotated key works at once and a revoked one stops within the TTL.
  const isSignedByAccount = async (
    { accountIndex, apiKeyIndex, payload, signature }: StrategiesServerClientFrame,
    allowStaleKey: boolean,
  ): Promise<boolean> => {
    if (!apiKeyIndexes.has(apiKeyIndex)) return false
    const id = `${accountIndex}:${apiKeyIndex}`
    const cached = publicKeys.get(id) ?? null
    const isFresh =
      cached !== null && clock.now() - cached.fetchedAt < STRATEGIES_WS_PUBLIC_KEY_TTL_MS
    const isSignedBy = async (publicKey: ApiPublicKey | null) =>
      publicKey !== null && (await verifySignature(publicKey, payload, signature))
    if (isFresh && (await isSignedBy(cached.publicKey))) return true
    const fetchPublicKey = async () => {
      const request = ++keyRequests
      const fetchedAt = clock.now()
      const publicKey = await getPublicKey(accountIndex, apiKeyIndex)
      // A slow response must not overwrite a newer one, which may have seen the key revoked.
      const newest = request > (publicKeys.get(id)?.request ?? 0)
      if (newest && accountIndex === getAccountIndex()) {
        publicKeys.set(id, { publicKey, fetchedAt, request })
      }
      return publicKey
    }
    // A stop or an ack does not wait on a slow backend; the refresh still lets a revoked key lapse.
    if (allowStaleKey && cached !== null && !isFresh && (await isSignedBy(cached.publicKey))) {
      if (!refreshingKeys.has(id)) {
        refreshingKeys.add(id)
        fetchPublicKey()
          .catch(() => {})
          .finally(() => refreshingKeys.delete(id))
      }
      return true
    }
    let publicKey: ApiPublicKey | null
    try {
      publicKey = await fetchPublicKey()
    } catch (error) {
      if (allowStaleKey && cached !== null && !isFresh) return false
      throw error
    }
    if (isFresh && isSameKey(publicKey, cached.publicKey)) return false
    return isSignedBy(publicKey)
  }

  const isCurrent = (connection: Connection, frame: StrategiesServerClientFrame) =>
    frame.challenge === connection.challenge && frame.seq > connection.seq

  // A stop or an ack still runs when its client disconnected while it was queued, and is
  // checked with the last key fetched when the backend cannot be reached.
  const handleCommand = async (
    socket: WebSocket,
    connection: Connection,
    frame: StrategiesServerClientFrame,
  ) => {
    const { command } = frame
    if (command.kind === 'hello') return
    const keepsRunning = command.kind === 'stop' || command.kind === 'ackErrors'
    let authorized: boolean
    try {
      authorized =
        isCurrent(connection, frame) &&
        frame.accountIndex === getAccountIndex() &&
        (await isSignedByAccount(frame, keepsRunning))
    } catch (error) {
      onError(error)
      refuse(socket, command, STRATEGIES_WS_AUTH_CHECK_FAILED_ERROR)
      return
    }
    if (authorized) connection.seq = frame.seq
    if (keepsRunning ? closed : isGone(socket)) return
    if (authorized) dispatch(socket, command)
    else refuse(socket, command, STRATEGIES_WS_UNAUTHORIZED_ERROR)
  }

  // Without a signer the hello is checked against its own account, which the server then signs for.
  const hello = async (
    socket: WebSocket,
    connection: Connection,
    frame: StrategiesServerClientFrame,
  ) => {
    const accountIndex = getAccountIndex() ?? frame.accountIndex
    const valid =
      isCurrent(connection, frame) &&
      frame.accountIndex === accountIndex &&
      (allowedAccountIndex === null || accountIndex === allowedAccountIndex) &&
      (await isSignedByAccount(frame, false))
    if (isGone(socket)) return
    if (!valid) {
      reject(socket)
      return
    }
    connection.seq = frame.seq
    if (getAccountIndex() === null) onRegister(accountIndex)
    if (getAccountIndex() === accountIndex) accept(socket)
    else reject(socket)
  }

  server.on('connection', (socket) => {
    // A client's protocol violation (oversized frame, bad UTF-8, ...) already closes its socket.
    socket.on('error', (error: Error & { code?: string }) => {
      if (!error.code?.startsWith('WS_ERR_')) onError(error)
    })
    missedPongs.set(socket, 0)
    socket.on('pong', () => missedPongs.set(socket, 0))
    socket.on('close', () => {
      clearHelloTimer(socket)
      authenticated.delete(socket)
      sentErrorIds.delete(socket)
      missedPongs.delete(socket)
      if (leader !== socket) return
      leader = null
      if (!closed) promote()
    })
    const connection: Connection = { challenge: randomBytes(32).toString('hex'), seq: -1 }
    send(socket, { kind: 'challenge', challenge: connection.challenge })
    helloTimers.set(
      socket,
      clock.setTimeout(() => {
        helloTimers.delete(socket)
        if (!authenticated.has(socket) && !isGone(socket)) reject(socket)
      }, STRATEGIES_WS_HELLO_TIMEOUT_MS),
    )
    const fail = (error: unknown) => {
      onError(error)
      if (!isGone(socket)) socket.close(STRATEGIES_WS_RETRY_CLOSE_CODE, 'auth check failed')
    }
    let helloReceived = false
    // Checked one at a time, so a command never overtakes the one sent before it.
    let commands = Promise.resolve()
    socket.on('message', (data) => {
      const frame = parseFrame(data)
      if (!frame) return
      if (!helloReceived) {
        if (frame.command.kind !== 'hello') return
        helloReceived = true
        // The check's own timeouts decide how a slow one closes.
        clearHelloTimer(socket)
        hello(socket, connection, frame).catch(fail)
        return
      }
      // Frames are ignored while the hello is being checked.
      if (!authenticated.has(socket)) return
      if (frame.command.kind === 'ackErrors' && leader !== socket) return
      commands = commands.then(() => handleCommand(socket, connection, frame)).catch(onError)
    })
  })

  server.on('error', onError)

  const ping = () => {
    pingTimer = clock.setTimeout(ping, pingIntervalMs)
    for (const socket of server.clients) {
      const missed = missedPongs.get(socket) ?? 0
      if (missed >= maxMissedPongs) {
        socket.terminate()
      } else if (socket.readyState === socket.OPEN) {
        missedPongs.set(socket, missed + 1)
        socket.ping()
      }
    }
  }

  const listening = new Promise<AddressInfo>((resolve, reject) => {
    server.once('listening', () => resolve(server.address() as AddressInfo))
    server.once('error', reject)
  })
  httpsServer?.listen(port, host)
  flushTimer = clock.setTimeout(flush, STRATEGIES_WS_UPDATE_INTERVAL_MS)
  pingTimer = clock.setTimeout(ping, pingIntervalMs)

  return {
    listening,
    setCertificate: (next) => httpsServer?.setSecureContext(next),
    close: () => {
      closed = true
      unsubscribe()
      unsubscribeSignerStatus()
      unsubscribePlatform()
      unsubscribeRegistration()
      unsubscribeErrors()
      if (flushTimer !== null) clock.clearTimeout(flushTimer)
      flushTimer = null
      if (pingTimer !== null) clock.clearTimeout(pingTimer)
      pingTimer = null
      for (const timer of helloTimers.values()) clock.clearTimeout(timer)
      helloTimers.clear()
      for (const socket of server.clients) socket.terminate()
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else if (httpsServer) {
            httpsServer.close(() => resolve())
            for (const socket of httpsSockets) socket.destroy()
          } else resolve()
        })
      })
    },
  }
}
