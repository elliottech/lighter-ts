import { Unpackr } from 'msgpackr'

import type { Encoding } from '../types/LighterWs'

const unpackr = new Unpackr({ int64AsNumber: true, mapsAsObjects: true })

// oxlint-disable-next-line typescript/no-explicit-any
export const decodeWsMessage = (e: MessageEvent<any>, encoding: Encoding) => {
  try {
    switch (encoding) {
      case 'json': {
        // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-return -- WebSocket payload decoding is intentionally dynamic.
        return JSON.parse(e.data)
      }
      case 'msgpack': {
        // oxlint-disable-next-line typescript/no-unsafe-return -- WebSocket payload decoding is intentionally dynamic.
        return unpackr.unpack(new Uint8Array(e.data))
      }
    }
  } catch {
    return null
  }
}
