import { keyBy } from 'lodash-es'
import type { Token as ApiToken } from 'zklighter-perps'

import type { Fallbacks } from '../fallbacks'
import { defaultL1Info, defaultSystemConfig } from '../fallbacks/defaults'
import type { LighterStore } from '../store/useLighterStore'
import type { AssetMeta, PerpsOrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'
import { normalizeTokens } from './normalizeTokens'
import { withDisplaySymbol } from './withDisplaySymbol'

export const applyFallbackTokens = (
  state: LighterStore,
  fallbackTokens: Fallbacks['tokens'],
): LighterStore['tokens'] =>
  state.tokens?.length || !fallbackTokens
    ? state.tokens
    : normalizeTokens(fallbackTokens.tokens as ApiToken[])

export const applyFallbacks = (
  state: LighterStore,
  fallbacks: Fallbacks,
): Partial<LighterStore> => {
  const tokens = applyFallbackTokens(state, fallbacks.tokens)
  const displaySymbols = Object.fromEntries(
    (tokens ?? []).map((token) => [token.backend_symbol, token.symbol]),
  )

  return {
    tokens,
    systemConfig:
      state.systemConfig === defaultSystemConfig ? fallbacks.systemConfig : state.systemConfig,
    l1Info: state.l1Info === defaultL1Info ? fallbacks.l1Info : state.l1Info,
    fallbackFeeTiers: fallbacks.feeTiers,
    ...(!state.orderBookMetasLoaded && {
      perpsOrderBookMetas: keyBy(
        (
          fallbacks.orderBookMetas.order_book_details as Omit<
            PerpsOrderBookDetail,
            'backend_symbol'
          >[]
        ).map((detail) => withDisplaySymbol(detail, displaySymbols)),
        'market_id',
      ),
      spotOrderBookMetas: keyBy(
        (
          fallbacks.orderBookMetas.spot_order_book_details as Omit<
            SpotOrderBookDetail,
            'backend_symbol'
          >[]
        ).map((detail) => withDisplaySymbol(detail, displaySymbols)),
        'market_id',
      ),
    }),
    ...(!state.assetMetasLoaded && {
      assetMetas: keyBy(
        (fallbacks.assetMetas.asset_details as Omit<AssetMeta, 'backend_symbol'>[]).map((detail) =>
          withDisplaySymbol(detail, displaySymbols),
        ),
        'asset_id',
      ),
    }),
  }
}
