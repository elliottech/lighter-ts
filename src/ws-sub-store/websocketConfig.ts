export type WebsocketConfig = {
  flushInterval: number
  throttleInterval: number
}

export const websocketConfig: WebsocketConfig = {
  flushInterval: 250,
  throttleInterval: 500,
}
