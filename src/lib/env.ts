export type Env =
  | 'local'
  | 'staging'
  | 'testnet'
  | 'mainnet'
  | 'robinhood-testnet'
  | 'robinhood-mainnet'

export const currentEnv: { env: Env } = { env: null! }

export const isRobinhoodEnv = () =>
  currentEnv.env === 'robinhood-testnet' || currentEnv.env === 'robinhood-mainnet'
