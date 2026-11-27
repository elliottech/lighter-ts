import { joinBaseUrl } from '../utils/joinBaseUrl'
import type { LighterWsInterface, LighterWsContructorParams } from './types/LighterWs'
import type { SendWsMessage } from './types/SendWsMessage'
import { decodeWsMessage } from './utils/decodeWsMessage'
import { transformWsMessage } from './utils/transformWsMessage'

class LighterWs implements LighterWsInterface {
  private webSocket: WebSocket | null = null

  constructor(params: LighterWsContructorParams) {
    const webSocket = new WebSocket(
      joinBaseUrl(
        params.baseUrl,
        '',
        `encoding=${params.encoding}&readonly=true` +
          (params.auth ? `&auth=${params.auth.token}` : '') +
          (params.server ? `&server=${params.server}` : params.auth ? '&server=auth' : ''),
      ),
    )
    this.webSocket = webSocket
    if (params.encoding === 'msgpack') {
      this.webSocket.binaryType = 'arraybuffer'
    }
    let opened = false
    this.webSocket.onopen = () => {
      opened = true
      params.onOpen?.(this)
    }
    this.webSocket.onclose = params.onClose ?? null
    // Node's WebSocket reports a rejected handshake (e.g. a revoked auth token)
    // with `error` only and never fires `close`.
    this.webSocket.onerror = () => {
      if (opened) return
      this.close()
      params.onClose?.()
    }
    this.webSocket.onmessage = (e) => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- WebSocket payload decoding is intentionally dynamic.
      const decodedWsMessage = decodeWsMessage(e, params.encoding)

      if (decodedWsMessage === null) {
        // We get messages from ws that are null in groups of 3, this is to prevent spamming
        return
      }

      let data
      try {
        data = transformWsMessage(decodedWsMessage)
      } catch (e) {
        if (params.onError)
          params.onError(e, {
            type: 'transform_ws_message',
          })
        return
      }
      params.onMessage?.(data, this)
    }
  }

  // The browser fires `close` only after the closing handshake, which on a dead
  // connection can land after a replacement socket has opened. Detach first so
  // a closed socket can no longer reach the caller's handlers.
  close() {
    const webSocket = this.webSocket
    if (!webSocket) return
    webSocket.onopen = null
    webSocket.onclose = null
    webSocket.onmessage = null
    webSocket.onerror = null
    webSocket.close()
  }
  sendMessage(message: SendWsMessage): void {
    this.webSocket?.send(JSON.stringify(message))
  }
}

export default LighterWs
