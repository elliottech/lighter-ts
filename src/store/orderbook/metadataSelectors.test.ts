import { describe, expect, it } from 'vitest'

import type { Token } from '../../types/tokenlist'
import {
  buildSyntheticPerpsEntry,
  buildSyntheticSpotEntry,
} from '../../utils/synthetic-market-details'
import {
  selectSpotOrderBookMetas,
  selectPerpsOrderBookMetas,
  selectUpcomingSymbols,
} from './metadataSelectors'
import { selectIsUpcomingMarket } from './selectors'

type State = Parameters<typeof selectIsUpcomingMarket>[0]

const PERPS_ID = 10
const SPOT_ID = 2050

const token = (symbol: string, market: 'PERPS' | 'SPOT'): Token =>
  ({
    symbol,
    backend_symbol: symbol,
    market,
    categories: ['UPCOMING'],
    is_allowed_mainnet: true,
  }) as unknown as Token

const makeState = (urlEnabledMarketIds: number[], currentMarketId = PERPS_ID) =>
  ({
    currentMarketId,
    tokens: [token('PERP', 'PERPS'), token('SPOT/USDC', 'SPOT')],
    perpsOrderBookMetas: { [PERPS_ID]: buildSyntheticPerpsEntry('PERP', PERPS_ID) },
    spotOrderBookMetas: { [SPOT_ID]: buildSyntheticSpotEntry('SPOT/USDC', SPOT_ID) },
    urlEnabledMarketIds: new Set(urlEnabledMarketIds),
  }) as unknown as State

const marketIds = (metas: Record<string, { market_id: number }>) =>
  Object.values(metas).map((meta) => meta.market_id)

describe('UPCOMING markets opened with enableMarkets', () => {
  it('shows the placeholder and hides the real market without the param', () => {
    const state = makeState([])

    expect(marketIds(selectPerpsOrderBookMetas(state))).toEqual([-2])
    expect(marketIds(selectSpotOrderBookMetas(state))).toEqual([-3])
    expect(selectIsUpcomingMarket({ ...state, currentMarketId: -2 })).toBe(true)
  })

  it.each([
    ['perps', PERPS_ID, selectPerpsOrderBookMetas],
    ['spot', SPOT_ID, selectSpotOrderBookMetas],
  ] as const)('keeps the real %s market and drops its placeholder', (_, id, selectMetas) => {
    const state = makeState([id], id)

    expect(marketIds(selectMetas(state))).toEqual([id])
    expect(selectIsUpcomingMarket(state)).toBe(false)
  })

  it('leaves the other upcoming market unchanged', () => {
    const state = makeState([PERPS_ID])

    expect(marketIds(selectSpotOrderBookMetas(state))).toEqual([-3])
    expect(selectUpcomingSymbols(state)).toEqual(new Set(['SPOT/USDC']))
  })

  it('changes nothing for an id that is not on the backend', () => {
    const state = makeState([9999])

    expect(marketIds(selectPerpsOrderBookMetas(state))).toEqual([-2])
    expect(marketIds(selectSpotOrderBookMetas(state))).toEqual([-3])
    expect(selectUpcomingSymbols(state)).toEqual(new Set(['PERP', 'SPOT/USDC']))
  })
})
