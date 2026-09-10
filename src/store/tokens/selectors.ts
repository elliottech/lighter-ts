import { getTokenUrl } from '../../images/getTokenUrl'
import type { Token } from '../../types/tokenlist'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'

import type { TokensSlice } from './createTokensSlice'

// Token maps are keyed by the raw backend symbol (metas' backend_symbol).
const buildTokenRecord = <V>(tokens: Token[], getValue: (token: Token) => V) => {
  const record: Record<string, V> = {}
  for (const token of tokens) {
    record[token.backend_symbol] = getValue(token)
  }
  return record
}

const getTokenKey = (token: Token) => token.backend_symbol

export const selectTokens = (state: TokensSlice) => state.tokens

export const selectUrlEnabledMarketIds = (state: TokensSlice) => state.urlEnabledMarketIds

export const selectUrlEnabledAssetIds = (state: TokensSlice) => state.urlEnabledAssetIds

export const selectTokensBySymbol = createSelector(
  [selectTokens],
  createTracking('selectTokensBySymbol', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => t)
  }),
)

export const selectRwaCoins = createSelector(
  [selectTokens],
  createTracking('selectRwaCoins', (tokens) => {
    if (!tokens) return new Set<string>()
    return new Set(tokens.filter((t) => t.asset_type === 'RWA').map(getTokenKey))
  }),
)

export const selectTokenNames = createSelector(
  [selectTokens],
  createTracking('selectTokenNames', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => t.name)
  }),
)

export const selectTokenLogos = createSelector(
  [selectTokens],
  createTracking('selectTokenLogos', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => t.logo)
  }),
)

export const selectDisplaySymbols = createSelector(
  [selectTokens],
  createTracking('selectDisplaySymbols', (tokens) => {
    if (!tokens) return {}
    return Object.fromEntries(tokens.map((t) => [t.backend_symbol, t.symbol]))
  }),
)

// Maps display symbols to raw backend symbols. When several tokens share a
// display symbol, the one whose backend symbol equals its display symbol wins.
export const selectRawAssetSymbolMap = createSelector(
  [selectTokens],
  createTracking('selectRawAssetSymbolMap', (tokens) => {
    if (!tokens) return {}
    const record: Record<string, string> = {}
    for (const token of tokens) {
      const key = getTokenKey(token)
      if (!(token.symbol in record) || key === token.symbol) {
        record[token.symbol] = key
      }
    }
    return record
  }),
)

export const selectDefaultOrderBookGroupBySymbol = createSelector(
  [selectTokens],
  createTracking('selectDefaultOrderBookGroupBySymbol', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => t.default_order_book_group_by)
  }),
)

export const selectGeckoIds = createSelector(
  [selectTokens],
  createTracking('selectGeckoIds', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => t.gecko_id)
  }),
)

export const selectPaprikaIds = createSelector(
  [selectTokens],
  createTracking('selectPaprikaIds', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => t.paprika_id)
  }),
)

export const selectDescriptionKeys = createSelector(
  [selectTokens],
  createTracking('selectDescriptionKeys', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => t.description_key)
  }),
)

export const selectTokenImageUrls = createSelector(
  [selectTokens],
  createTracking('selectTokenImageUrls', (tokens) => {
    if (!tokens) return {}
    return buildTokenRecord(tokens, (t) => getTokenUrl(t.logo, t.logo_extension))
  }),
)

export const selectTokenIconMap = createSelector(
  [selectTokens],
  createTracking('selectTokenIconMap', (tokens) => {
    if (!tokens) return {}
    return Object.fromEntries(tokens.map((t) => [t.logo, getTokenUrl(t.logo, t.logo_extension)]))
  }),
)

export const selectTokenSymbols = createSelector(
  [selectTokens],
  createTracking('selectTokenSymbols', (tokens) => {
    if (!tokens) return new Set<string>()
    return new Set(tokens.map(getTokenKey))
  }),
)

export const selectAllowedTokenSymbols = createSelector(
  [selectTokens],
  createTracking('selectAllowedTokenSymbols', (tokens) => {
    if (!tokens) return new Set<string>()
    return new Set(tokens.filter((t) => t.is_allowed_mainnet).map(getTokenKey))
  }),
)

export const selectAllowedAssetSymbols = createSelector(
  [selectTokens],
  createTracking('selectAllowedAssetSymbols', (tokens) => {
    if (!tokens) return new Set<string>()
    return new Set(tokens.filter((t) => t.is_asset_allowed_mainnet).map(getTokenKey))
  }),
)
