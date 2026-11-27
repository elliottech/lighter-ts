import { describe, expect, it } from 'vitest'

import { OrderType } from '../../types/order'
import { selectCurrentMarket } from '../orderbook/selectors'
import { selectOrderType } from './selectors'

type State = Parameters<typeof selectOrderType>[0]

const makeState = (orderType: OrderType = OrderType.Conditional, currentMarketId = 1) =>
  ({
    preferences: { orderType, closePositionOrderType: OrderType.Limit },
    displayedForm: { type: 'placeOrder' },
    currentMarketId,
    spotOrderBookMetas: { 2: { market_type: 'spot' } },
    perpsOrderBookMetas: {},
    tokens: [],
    urlEnabledMarketIds: new Set<number>(),
  }) as unknown as State

describe('effective order type', () => {
  it('derives Market on spot and Conditional on perps without changing the saved choice', () => {
    const state = makeState()
    const preferences = Object.freeze(state.preferences)
    expect(selectOrderType(state)).toBe(OrderType.Conditional)
    state.currentMarketId = 2
    expect(selectOrderType(state)).toBe(OrderType.Market)
    expect(state.preferences).toBe(preferences)
    expect(state.preferences.orderType).toBe(OrderType.Conditional)
    state.currentMarketId = 1
    expect(selectOrderType(state)).toBe(OrderType.Conditional)
  })

  it('preserves the choice after serializing and reloading while on spot', () => {
    const stored = JSON.stringify(makeState(OrderType.Conditional, 2))
    const reloaded = JSON.parse(stored) as State
    expect(selectOrderType(reloaded)).toBe(OrderType.Market)
    reloaded.currentMarketId = 1
    expect(selectOrderType(reloaded)).toBe(OrderType.Conditional)
  })

  it.each([OrderType.Market, OrderType.Limit, OrderType.Scale, OrderType.Twap])(
    'keeps supported %s on both market types',
    (type) => {
      expect(selectOrderType(makeState(type, 1))).toBe(type)
      expect(selectOrderType(makeState(type, 2))).toBe(type)
    },
  )

  it('preserves explicit calculation overrides', () => {
    expect(
      selectOrderType(makeState(OrderType.Market, 2), { orderType: OrderType.Conditional }),
    ).toBe(OrderType.Conditional)
  })

  it('keeps close-position type independent of the entry-order preference', () => {
    const state = makeState(OrderType.Conditional, 2)
    state.displayedForm = { type: 'closePosition' }
    expect(selectOrderType(state)).toBe(OrderType.Limit)
    expect(selectOrderType(state, { displayedForm: { type: 'placeOrder' } })).toBe(OrderType.Market)
  })

  it('does not discard the choice before market metadata is available', () => {
    const state = makeState(OrderType.Conditional, 3)
    expect(selectOrderType(state)).toBe(OrderType.Conditional)
    const loaded = { ...state, spotOrderBookMetas: { 3: state.spotOrderBookMetas[2]! } }
    expect(selectOrderType(loaded)).toBe(OrderType.Market)
    expect(state.preferences.orderType).toBe(OrderType.Conditional)
  })

  it.each(['SPOT', 'PERPS'] as const)(
    'uses the page metadata for an upcoming %s market without changing the saved choice',
    (market) => {
      const state = {
        ...makeState(OrderType.Conditional, -2),
        tokens: [
          {
            symbol: 'UPCOMING',
            backend_symbol: 'UPCOMING',
            market,
            is_allowed_mainnet: true,
            categories: ['UPCOMING'],
          },
        ],
      } as unknown as State
      const expected = market === 'SPOT' ? OrderType.Market : OrderType.Conditional
      expect(state.spotOrderBookMetas[-2]).toBeUndefined()
      expect(selectCurrentMarket(state).market_type).toBe(market === 'PERPS' ? 'perp' : 'spot')
      expect(selectOrderType(state)).toBe(expected)
      const reloaded = {
        ...state,
        preferences: JSON.parse(JSON.stringify(state.preferences)) as State['preferences'],
      }
      expect(selectOrderType(reloaded)).toBe(expected)
      expect(selectOrderType({ ...reloaded, currentMarketId: 1 })).toBe(OrderType.Conditional)
      expect(state.preferences.orderType).toBe(OrderType.Conditional)
    },
  )

  it('keeps an explicit Market choice after returning to perps', () => {
    const state = makeState(OrderType.Conditional, 2)
    state.preferences = { ...state.preferences, orderType: OrderType.Market }
    state.currentMarketId = 1
    expect(selectOrderType(state)).toBe(OrderType.Market)
  })
})
