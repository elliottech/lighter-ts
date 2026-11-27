import tokens from '../mainnet/tokens.json'
import type { TokensOnlyFallbacks } from '../types'

const fallbacks: TokensOnlyFallbacks = {
  env: 'local',
  tokens,
}

export default fallbacks
