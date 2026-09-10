export type SendWsPingMessage = {
  type: 'ping'
}

export type SendWsPongMessage = {
  type: 'pong'
}

export type SendWsSubscribeMessage = {
  type: 'subscribe'
  channel: string
  auth?: string
  flushInterval?: string
}

export type SendWsUnsubscribeMessage = {
  type: 'unsubscribe'
  channel: string
}

export type SendWsAgentMessage = {
  type: 'jsonapi/agent'
  channel: string
  auth: string
  data: { id: string; question: string }
}

export type SendWsMessage =
  | SendWsPingMessage
  | SendWsPongMessage
  | SendWsSubscribeMessage
  | SendWsUnsubscribeMessage
  | SendWsAgentMessage
