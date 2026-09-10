export const wsChannelReconnectTimeout = (retries: number) => {
  if (retries <= 1) return 3000
  if (retries === 2) return 6000
  if (retries === 3) return 10000
  if (retries > 3) return 15000
}
