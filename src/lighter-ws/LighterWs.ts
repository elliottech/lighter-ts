import type { LighterWsInterface, LighterWsContructorParams } from './types/LighterWs'
import type { SendWsMessage } from './types/SendWsMessage'
import { decodeWsMessage } from './utils/decodeWsMessage'
import { transformWsMessage } from './utils/transformWsMessage'

class LighterWs implements LighterWsInterface {
  private webSocket: WebSocket | null = null

  constructor(params: LighterWsContructorParams) {
    const webSocket = new WebSocket(
      params.baseUrl +
        `?encoding=${params.encoding}&readonly=true` +
        (params.auth ? `&auth=${params.auth.token}` : '') +
        (params.server ? `&server=${params.server}` : params.auth ? '&server=auth' : ''),
    )
    this.webSocket = webSocket
    if (params.encoding === 'msgpack') {
      this.webSocket.binaryType = 'arraybuffer'
    }
    this.webSocket.onopen = () => {
      params.onOpen?.(this)
    }
    this.webSocket.onclose = params.onClose ?? null
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

  close() {
    this.webSocket?.close()
  }
  sendMessage(message: SendWsMessage): void {
    this.webSocket?.send(JSON.stringify(message))
  }
}

export default LighterWs
