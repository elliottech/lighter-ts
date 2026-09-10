import type { Token as ApiToken } from 'zklighter-perps'

import type { Token } from '../types/tokenlist'

export const normalizeTokens = (tokens: ApiToken[]): Token[] =>
  tokens.map((token) => ({ ...token, backend_symbol: token.backend_symbol || token.symbol }))
