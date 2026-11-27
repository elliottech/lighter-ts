import type { StateCreator } from 'zustand'

import type { Token } from '../../types/tokenlist'

export interface TokensSlice {
  tokens: Token[] | null
  urlEnabledMarketIds: Set<number>
  urlEnabledAssetIds: Set<number>
}

export const createTokensSlice: StateCreator<TokensSlice, [], [], TokensSlice> = () => ({
  tokens: null,
  urlEnabledMarketIds: new Set<number>(),
  urlEnabledAssetIds: new Set<number>(),
})
