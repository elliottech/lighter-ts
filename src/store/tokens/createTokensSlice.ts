import type { Token as ApiToken } from 'zklighter-perps'
import type { StateCreator } from 'zustand'

import { tokensFallback } from '../../fallbacks'
import type { Token } from '../../types/tokenlist'
import { normalizeTokens } from '../../utils/normalizeTokens'

export interface TokensSlice {
  tokens: Token[] | null
  urlEnabledMarketIds: Set<number>
  urlEnabledAssetIds: Set<number>
}

export const createTokensSlice: StateCreator<TokensSlice, [], [], TokensSlice> = () => ({
  tokens: normalizeTokens(tokensFallback.tokens as ApiToken[]),
  urlEnabledMarketIds: new Set<number>(),
  urlEnabledAssetIds: new Set<number>(),
})
