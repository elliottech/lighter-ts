import type { StrategyRecord } from './engine/types'
import type { MainToWorker } from './worker/protocol'

/**
 * Messages between a frontend and the strategies server
 * (`yarn strategies-server`), as JSON text frames. The client connects to
 * `ws://<host>:<port>/` (`wss://<ip>:<port>/` with STRATEGIES_TLS_IP set),
 * gets a `challenge`, and answers with a signed
 * `hello`; every frame it sends after is signed the same way. Signatures
 * prove who sent a frame, they do not hide it: without TLS anyone on the path
 * can read every frame.
 */

/**
 * The API key the server generated a seed for, and its changePubKey signed by
 * that key with an empty `L1Sig`. The frontend has the wallet sign the
 * "Register Lighter Account" body it builds itself from `publicKey`, `nonce`,
 * `accountIndex` and `apiKeyIndex`, puts the signature in `L1Sig` and sends
 * the tx to Lighter. The seed never leaves the server.
 */
export interface StrategiesServerRegistration {
  accountIndex: number
  apiKeyIndex: number
  /** Hex, as `createClient` returns it. `txInfo.PubKey` holds the same bytes in base64. */
  publicKey: string
  nonce: number
  /** `txInfo.ExpiredAt`, epoch ms. After it, a `start` gets the frontend a new registration. */
  expiredAt: number
  /** The changePubKey tx info JSON, with `L1Sig` empty. */
  txInfo: string
}

/**
 * Installs this version of the server's package from the registry and
 * restarts the server on it. Only a server run through the
 * `strategies-server` launcher can update.
 */
export interface StrategiesServerUpdate {
  kind: 'update'
  version: string
}

/**
 * Marks every error up to `lastErrorId` as reported, so `connected` no longer
 * sends them. Only the leader connection sends it, once it forwarded them to
 * Sentry; it gets no answer.
 */
export interface StrategiesServerAckErrors {
  kind: 'ackErrors'
  lastErrorId: number
}

export type StrategiesServerLogsSize = 'small' | 'large'

/**
 * Asks for the server's logs as one gzip stream: `small` is the last 2 log
 * chunks (10 MB each, so at most 20 MB), `large` every chunk kept (up to
 * `STRATEGIES_SERVER_LOGS_MAX_MB`). Answered by `logs`, the gzip in binary
 * frames, then `logsEnd`, or by `logsFailed`. One at a time per server.
 */
export interface StrategiesServerDownloadLogs {
  kind: 'downloadLogs'
  id: string
  size: StrategiesServerLogsSize
}

/**
 * The same start / stop / remove / refreshTier the worker takes, `update`,
 * `ackErrors` or `downloadLogs`. Send `refreshTier` after the account's tier changes; it gets no
 * answer.
 */
export type StrategiesServerCommand =
  | MainToWorker
  | StrategiesServerUpdate
  | StrategiesServerAckErrors
  | StrategiesServerDownloadLogs

/**
 * An exception the server or its worker captured, kept on disk (the latest
 * 1000) until a frontend forwards it to Sentry.
 */
export interface StrategiesServerError {
  /** Increasing, the cursor `ackErrors` takes. */
  id: number
  /** Epoch ms the server captured it at. */
  timestamp: number
  name: string
  message: string
  stack?: string
  tags: Record<string, string>
  /** The server bundle's `_sentryDebugIds`. */
  debugIds?: Record<string, string>
  /** The id of the strategy it was captured for, when there is one. */
  strategyId?: string
  /** The server version that captured it, null when not run by the launcher. */
  version: string | null
}

/** The first frame a client sends, answering the `challenge`. */
export interface StrategiesServerHello {
  kind: 'hello'
}

export type StrategiesServerClientCommand = StrategiesServerHello | StrategiesServerCommand

/**
 * What a client signs with an API key of the account the server signs for
 * (any of its keys). `challenge` is the one this connection was sent, and
 * `seq` grows with every frame, so a frame cannot be replayed on another
 * connection or twice on the same one.
 */
export interface StrategiesServerSignedPayload {
  challenge: string
  seq: number
  accountIndex: number
  apiKeyIndex: number
  command: StrategiesServerClientCommand
}

/**
 * Frontend → server. `payload` is the JSON of a `StrategiesServerSignedPayload`
 * and `signature` the signer's `signStrategyServerCommand` of that exact
 * string. A `hello` that fails the check gets `unauthenticated`; a command
 * gets `rejected`, `logsFailed` or `updateResult` with `ok: false`.
 */
export interface StrategiesServerSignedFrame {
  payload: string
  signature: string
}

/** The frame to send for `payload`, signed by `sign`. */
export const signStrategiesServerFrame = async (
  payload: StrategiesServerSignedPayload,
  sign: (payload: string) => Promise<string>,
): Promise<string> => {
  const text = JSON.stringify(payload)
  const frame: StrategiesServerSignedFrame = { payload: text, signature: await sign(text) }
  return JSON.stringify(frame)
}

/**
 * `starting` until the worker's signer is initialised (`ready`) or is
 * rejected (`failed`: none yet, or its key is not registered or was revoked).
 * While `failed`, a `start` restarts the worker, which adopts the pending
 * key if it got registered meanwhile.
 */
export type StrategiesServerSignerStatus = 'starting' | 'ready' | 'failed'

/**
 * Whether the server runs its strategies. `starting`: the first maintenance
 * check has not answered yet, a `start` or `remove` is rejected until it has.
 * `scheduled`: a downtime is announced for `maintenanceAt`. `down`: the
 * worker is stopped for a downtime (or an outage, with a null
 * `maintenanceAt`); `recovering`: it is
 * probing the backend. While `down` or `recovering` the running strategies
 * stay `running` and resume after it, a `start` or `remove` is rejected, and
 * a `stop` is applied at once and its orders cancelled after it.
 */
export type StrategiesServerPlatformStatus = 'starting' | 'up' | 'scheduled' | 'down' | 'recovering'

export interface StrategiesServerPlatform {
  status: StrategiesServerPlatformStatus
  /** Epoch ms of the announced downtime's start. */
  maintenanceAt: number | null
}

export type StrategiesServerMessage =
  /** Sent first on every connection; the `hello` has to be signed with it. */
  | { kind: 'challenge'; challenge: string }
  /** Sent once the `hello` was verified, with every record in the store
   *  and the latest 50 errors not acked yet, by increasing id, with
   *  `skippedErrorsCount` older unacked ones left out. `version` is null
   *  when the server was not started by the launcher. `isLeaderConnection`
   *  is true for the first connection accepted while no other leader is
   *  connected; when the leader disconnects another connection gets
   *  `leaderUpdate`. Only the leader forwards the errors to Sentry and acks them. */
  | {
      kind: 'connected'
      strategies: StrategyRecord[]
      signer: StrategiesServerSignerStatus
      version: string | null
      platform: StrategiesServerPlatform
      errors: StrategiesServerError[]
      skippedErrorsCount: number
      isLeaderConnection: boolean
    }
  /** Sent at most once a second with the latest 50 errors captured since
   *  the previous `connected` or `errors`, by increasing id.
   *  `skippedErrorsCount` is how many older ones captured in that time were
   *  left out. */
  | { kind: 'errors'; errors: StrategiesServerError[]; skippedErrorsCount: number }
  /** Sent to the connection promoted to leader after the previous leader
   *  disconnected, with the latest 50 errors not acked yet, by increasing id,
   *  and `skippedErrorsCount` older unacked ones left out. */
  | { kind: 'leaderUpdate'; errors: StrategiesServerError[]; skippedErrorsCount: number }
  /** Sent at most once a second, with the records that changed since the
   *  previous one and the ids of the records removed since. */
  | { kind: 'updated'; strategies: StrategyRecord[]; removed: string[] }
  /** Sent when the platform status changes. */
  | ({ kind: 'platform' } & StrategiesServerPlatform)
  /** Sent when the signer status changes. */
  | { kind: 'signer'; status: StrategiesServerSignerStatus }
  /** Sent to connected clients when the worker signed a registration for a
   *  new key, after its signer was rejected, and after `connected` while one
   *  is pending. A `start` while the signer is failed also asks for one. */
  | { kind: 'authRequired'; registration: StrategiesServerRegistration }
  /** The answer to an `update`. After `ok: true` the server closes every
   *  socket and restarts on the new version. */
  | { kind: 'updateResult'; ok: true }
  | { kind: 'updateResult'; ok: false; error: string }
  /** The start / stop / remove with this id was dropped: its signature was
   *  rejected or could not be checked, the server had no worker to run it
   *  (the worker is restarting), or it is paused for a
   *  downtime. */
  | { kind: 'rejected'; id: string; error: string }
  /** The answer to a `downloadLogs`: the binary frames that follow, up to
   *  `logsEnd` with the same id, are the gzip of `bytes` bytes of logs. */
  | { kind: 'logs'; id: string; size: StrategiesServerLogsSize; bytes: number }
  | { kind: 'logsEnd'; id: string }
  /** The `downloadLogs` with this id failed, before or after its `logs`. */
  | { kind: 'logsFailed'; id: string; error: string }
  /** Sent instead of `connected` when the `hello` is missing, late or
   *  rejected; the server closes the socket right after. */
  | { kind: 'unauthenticated' }
