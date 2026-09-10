export const MAX_WS_CHANNEL_SUBSCRIBE_RETRIES = 10

export interface ChannelStatus {
  timeout: NodeJS.Timeout | null
  retries: number
}

// If the channel has a timeout for retrying then it's loading
export const channelIsLoading = (channel?: ChannelStatus) => !!channel?.timeout

export const channelFailedToConnect = (channel?: ChannelStatus) =>
  !!(channel?.timeout && channel?.retries === MAX_WS_CHANNEL_SUBSCRIBE_RETRIES)

export const channelNotConnected = (channel?: ChannelStatus) => channel === undefined
