export type WebsocketConfig = {
  flushInterval: number
  throttleInterval: number | null
  accountThrottleInterval: number | null
  boEnabled: boolean
}

export const websocketConfig: WebsocketConfig = {
  flushInterval: 250,
  throttleInterval: 500,
  // Short enough that a placed / cancelled order still feels instant, long
  // enough to collapse a burst of account messages into one store commit.
  accountThrottleInterval: 50,
  boEnabled: false,
}
