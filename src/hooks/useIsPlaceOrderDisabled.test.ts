import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrderBookSlice } from '../store/orderbook/createOrderBookSlice'
import { OrderType } from '../types/order'
import { useIsPlaceOrderDisabled } from './useIsPlaceOrderDisabled'

const mocks = vi.hoisted(() => ({
  invalidStopLoss: false,
  invalidTakeProfit: false,
  isMarketDataLive: true,
  state: {} as Record<string, unknown>,
}))

vi.mock('../store/useLighterStore', () => ({
  useLighterStore: <T>(selector: (state: unknown) => T) => selector(mocks.state),
}))
vi.mock('../ws-sub-store/useWsSubStore', () => ({
  useWsSubStore: <T>(selector: (state: unknown) => T) => selector({}),
}))
vi.mock('../ws-sub-store/selectIsMarketDataLive', () => ({
  selectIsMarketDataLive: () => mocks.isMarketDataLive,
}))
vi.mock('../store/selectors/sltp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/selectors/sltp')>()),
  selectInvalidStopLossPriceText: () => (mocks.invalidStopLoss ? 'invalid' : undefined),
  selectInvalidTakeProfitPriceText: () => (mocks.invalidTakeProfit ? 'invalid' : undefined),
}))
vi.mock('../store/selectors/validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/selectors/validation')>()),
  selectIsPlaceOrderSizeInvalid: () => false,
  selectIsReduceOnlyInvalid: () => false,
  selectNotEnoughMargin: () => false,
}))

const LOADED_BOOK: OrderBookSlice['orderBook'] = {
  asks: [{ price: 3000, size: 5 }],
  bids: [{ price: 2999, size: 5 }],
}

const setState = (orderType: OrderType, orderBook: OrderBookSlice['orderBook']) => {
  mocks.state = {
    currentMarketId: 0,
    displayedForm: { type: 'placeOrder' },
    orderBook,
    orderBookMetas: {},
    preferences: { orderType, closePositionOrderType: OrderType.Market },
  }
}

describe('useIsPlaceOrderDisabled', () => {
  beforeEach(() => {
    mocks.invalidStopLoss = false
    mocks.invalidTakeProfit = false
    mocks.isMarketDataLive = true
    setState(OrderType.Limit, LOADED_BOOK)
  })

  it.each([
    ['stop loss', 'invalidStopLoss'],
    ['take profit', 'invalidTakeProfit'],
  ] as const)('blocks an order with an invalid %s by default', (_name, key) => {
    mocks[key] = true
    expect(useIsPlaceOrderDisabled()).toBe(true)
  })

  it.each([
    ['stop loss', 'invalidStopLoss'],
    ['take profit', 'invalidTakeProfit'],
  ] as const)('ignores an invalid %s for an order sent without SL/TP', (_name, key) => {
    mocks[key] = true
    expect(useIsPlaceOrderDisabled({ includeSLTP: false })).toBe(false)
  })

  it.each(Object.values(OrderType))('blocks a %s order while the order book is loading', (type) => {
    setState(type, null)
    expect(useIsPlaceOrderDisabled()).toBe(true)
  })

  it.each(Object.values(OrderType))('allows a %s order once the order book is loaded', (type) => {
    setState(type, LOADED_BOOK)
    expect(useIsPlaceOrderDisabled()).toBe(false)
  })

  it.each(Object.values(OrderType))('blocks a %s order while market data is not live', (type) => {
    setState(type, LOADED_BOOK)
    mocks.isMarketDataLive = false
    expect(useIsPlaceOrderDisabled()).toBe(true)
  })
})
