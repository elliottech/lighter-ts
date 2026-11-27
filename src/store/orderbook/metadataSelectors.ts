import { pickBy } from 'lodash-es'

import type {
  OrderBookDetail,
  PerpsOrderBookDetail,
  SpotOrderBookDetail,
} from '../../types/compatibility'
import {
  buildSyntheticPerpsEntry,
  buildSyntheticSpotEntry,
} from '../../utils/synthetic-market-details'
import {
  selectTokens,
  selectTokenSymbols,
  selectAllowedTokenSymbols,
  selectUrlEnabledMarketIds,
} from '../tokens/selectors'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'
import type { OrderBookSlice } from './createOrderBookSlice'

const selectRawSpotOrderBookMetas = (state: OrderBookSlice) => state.spotOrderBookMetas

const selectRawPerpsOrderBookMetas = (state: OrderBookSlice) => state.perpsOrderBookMetas

const EMPTY_SYMBOLS = new Set<string>()

const selectUrlEnabledBackendSymbols = createSelector(
  [selectRawSpotOrderBookMetas, selectRawPerpsOrderBookMetas, selectUrlEnabledMarketIds],
  createTracking('selectUrlEnabledBackendSymbols', (spotMetas, perpsMetas, urlEnabledMarketIds) => {
    if (!urlEnabledMarketIds.size) return EMPTY_SYMBOLS
    return new Set(
      [...Object.values(spotMetas), ...Object.values(perpsMetas)]
        .filter((meta) => urlEnabledMarketIds.has(meta.market_id))
        .map((meta) => meta.backend_symbol),
    )
  }),
)

export const selectUpcomingSymbols = createSelector(
  [selectTokens, selectUrlEnabledBackendSymbols],
  createTracking(
    'selectUpcomingSymbols',
    (tokens, urlEnabledBackendSymbols) =>
      new Set(
        (tokens ?? [])
          .filter(
            (t) =>
              t.is_allowed_mainnet &&
              t.categories.includes('UPCOMING') &&
              !urlEnabledBackendSymbols.has(t.backend_symbol),
          )
          .map((t) => t.backend_symbol),
      ),
  ),
)

const selectSyntheticPerpsOrderBookMetas = createSelector(
  [selectTokens, selectUpcomingSymbols],
  createTracking('selectSyntheticPerpsOrderBookMetas', (tokens, upcomingSymbols) => {
    if (!tokens) return {}
    return tokens.reduce<Record<string, PerpsOrderBookDetail>>((acc, t, i) => {
      if (t.market === 'PERPS' && upcomingSymbols.has(t.backend_symbol)) {
        const id = -(i + 2)
        acc[id] = buildSyntheticPerpsEntry(t.symbol, id, t.backend_symbol)
      }
      return acc
    }, {})
  }),
)

const selectSyntheticSpotOrderBookMetas = createSelector(
  [selectTokens, selectUpcomingSymbols],
  createTracking('selectSyntheticSpotOrderBookMetas', (tokens, upcomingSymbols) => {
    if (!tokens) return {}
    return tokens.reduce<Record<string, SpotOrderBookDetail>>((acc, t, i) => {
      if (t.market === 'SPOT' && upcomingSymbols.has(t.backend_symbol)) {
        const id = -(i + 2)
        acc[id] = buildSyntheticSpotEntry(t.symbol, id, t.backend_symbol)
      }
      return acc
    }, {})
  }),
)

export const selectSyntheticOrderBookMetas = createSelector(
  [selectSyntheticSpotOrderBookMetas, selectSyntheticPerpsOrderBookMetas],
  createTracking('selectSyntheticOrderBookMetas', (spot, perps) => ({ ...spot, ...perps })),
)

const isAllowedMeta = (
  meta: OrderBookDetail,
  id: string,
  tokenSymbols: Set<string>,
  allowedTokenSymbols: Set<string>,
  urlEnabledMarketIds: Set<number>,
  upcomingSymbols: Set<string>,
) => {
  if (upcomingSymbols.has(meta.backend_symbol)) return false
  if (!tokenSymbols.has(meta.backend_symbol)) return true
  return allowedTokenSymbols.has(meta.backend_symbol) || urlEnabledMarketIds.has(Number(id))
}

export const selectSpotOrderBookMetas = createSelector(
  [
    selectRawSpotOrderBookMetas,
    selectSyntheticSpotOrderBookMetas,
    selectTokenSymbols,
    selectAllowedTokenSymbols,
    selectUrlEnabledMarketIds,
    selectUpcomingSymbols,
  ],
  createTracking(
    'selectSpotOrderBookMetas',
    (
      metas,
      synthetics,
      tokenSymbols,
      allowedTokenSymbols,
      urlEnabledMarketIds,
      upcomingSymbols,
    ) => ({
      ...pickBy(metas, (meta, id) =>
        isAllowedMeta(
          meta,
          id,
          tokenSymbols,
          allowedTokenSymbols,
          urlEnabledMarketIds,
          upcomingSymbols,
        ),
      ),
      ...synthetics,
    }),
  ),
)

export const selectPerpsOrderBookMetas = createSelector(
  [
    selectRawPerpsOrderBookMetas,
    selectSyntheticPerpsOrderBookMetas,
    selectTokenSymbols,
    selectAllowedTokenSymbols,
    selectUrlEnabledMarketIds,
    selectUpcomingSymbols,
  ],
  createTracking(
    'selectPerpsOrderBookMetas',
    (
      metas,
      synthetics,
      tokenSymbols,
      allowedTokenSymbols,
      urlEnabledMarketIds,
      upcomingSymbols,
    ) => ({
      ...pickBy(metas, (meta, id) =>
        isAllowedMeta(
          meta,
          id,
          tokenSymbols,
          allowedTokenSymbols,
          urlEnabledMarketIds,
          upcomingSymbols,
        ),
      ),
      ...synthetics,
    }),
  ),
)

export const selectOrderBookMetas = createSelector(
  [selectSpotOrderBookMetas, selectPerpsOrderBookMetas],
  createTracking('selectOrderBookMetas', (spotOrderBookMetas, perpsOrderBookMetas) => ({
    ...spotOrderBookMetas,
    ...perpsOrderBookMetas,
  })),
)
