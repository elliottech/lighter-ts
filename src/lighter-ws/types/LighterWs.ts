import type { SendWsMessage } from './SendWsMessage'
import type { WsMessage } from './WsMessage'

export type Encoding = 'msgpack' | 'json'

export interface LighterWsInterface {
  close(): void
  sendMessage(message: SendWsMessage): void
}

export interface LighterWsContructorParams {
  baseUrl: string
  encoding: Encoding
  auth?: {
    token: string
  }
  server?: string

  onOpen?: (lighterWs: LighterWsInterface) => void
  onClose?: () => void
  onMessage?: (message: WsMessage, lighterWs: LighterWsInterface) => void
  onError?: (err: unknown, tags?: unknown) => void
}
