import { beforeEach, describe, expect, it } from 'vitest'
import {
  AccountAssetMarginModeEnum,
  AccountPositionMarginModeEnum,
  AccountPositionSignEnum,
} from 'zklighter-perps'

import { OrderDirections } from '../../constants/shared'
import { OrderType } from '../../types/order'
import type {
  WsAssetBalance,
  WsAssetStats,
  WsPerpsMarketStats,
  WsSpotMarketStats,
} from '../../lighter-ws/types/WsMessage'
import { USDC_ASSET_ID } from '../orderbook/selectors'
import type { Position } from '../types'
import { useLighterStore } from '../useLighterStore'
import {
  selectFlipsOppositeSidePosition,
  selectIsFairPriceMissing,
  selectIsMarketOrderFairPriceMissing,
  selectIsPriceFarFromFairPrice,
  selectShowOppositeSidePositionWarning,
  selectShowPriceProtectionWarning,
  selectSlippage,
  selectVeryHighSlippage,
  selectVeryHighSpread,
} from './placeOrder'
import { selectEstPrice } from './common'
import mainnetFallbacks from '../../fallbacks/mainnet'
import { applyFallbacks } from '../../utils/applyFallbacks'

useLighterStore.setState((state) => applyFallbacks(state, mainnetFallbacks))

const MARKET_ID = 0

type Book = {
  asks: { price: number; size: number }[]
  bids: { price: number; size: number }[]
}

const setMarket = (orderBook: Book, markPrice = 100) =>
  useLighterStore.setState({
    currentMarketId: MARKET_ID,
    orderBook,
    perpsMarketsStats: {
      [MARKET_ID]: { mark_price: markPrice, index_price: markPrice } as WsPerpsMarketStats,
    },
  })

const read = (direction: OrderDirections, orderType: OrderType = OrderType.Market) => {
  const params = { direction, orderType, pinnedInput: 'base' as const, pinnedValueInputValue: '1' }
  const state = useLighterStore.getState()
  return {
    estPrice: selectEstPrice(state, params),
    slippage: selectSlippage(state, params),
    veryHighSlippage: selectVeryHighSlippage(state, params),
    veryHighSpread: selectVeryHighSpread(state, params),
    showPriceProtectionWarning: selectShowPriceProtectionWarning(state, params),
  }
}

describe('market order price protection', () => {
  beforeEach(() => {
    useLighterStore.setState({ orderBook: null, perpsMarketsStats: {} })
  })

  it('forces a confirmation for a buy into a hollow book far above mark', () => {
    setMarket({ asks: [{ price: 150, size: 10 }], bids: [] })

    const result = read(OrderDirections.Long)
    expect(result.estPrice).toBe(150)
    expect(result.slippage).toBe(0)
    expect(result.veryHighSlippage).toBe(false)
    expect(result.veryHighSpread).toBe(false)
    expect(result.showPriceProtectionWarning).toBe(true)
  })

  it('forces a confirmation for a sell into a hollow book far below mark', () => {
    setMarket({ asks: [], bids: [{ price: 50, size: 10 }] })

    expect(read(OrderDirections.Short).showPriceProtectionWarning).toBe(true)
  })

  it('does not warn when the book trades near mark', () => {
    setMarket({ asks: [{ price: 100.5, size: 10 }], bids: [{ price: 99.5, size: 10 }] })

    expect(read(OrderDirections.Long).showPriceProtectionWarning).toBe(false)
    expect(read(OrderDirections.Short).showPriceProtectionWarning).toBe(false)
  })

  it('leaves an empty own side to the no-liquidity guard', () => {
    setMarket({ asks: [], bids: [{ price: 99.5, size: 10 }] })

    expect(read(OrderDirections.Long).showPriceProtectionWarning).toBe(false)
  })

  it('does not apply to non-market order types', () => {
    setMarket({ asks: [{ price: 150, size: 10 }], bids: [] })

    expect(read(OrderDirections.Long, OrderType.Twap).showPriceProtectionWarning).toBe(false)
  })
})

describe('market order without a fair price', () => {
  const NEAR_BOOK: Book = {
    asks: [{ price: 100.5, size: 10 }],
    bids: [{ price: 99.5, size: 10 }],
  }

  const readMissing = (direction: OrderDirections, orderType: OrderType = OrderType.Market) => {
    const params = {
      direction,
      orderType,
      pinnedInput: 'base' as const,
      pinnedValueInputValue: '1',
    }
    const state = useLighterStore.getState()
    return {
      fairPriceMissing: selectIsMarketOrderFairPriceMissing(state, params),
      showPriceProtectionWarning: selectShowPriceProtectionWarning(state, params),
    }
  }

  beforeEach(() => {
    useLighterStore.setState({ orderBook: null, perpsMarketsStats: {}, spotMarketsStats: {} })
  })

  it('forces a confirmation when the book has loaded but mark and index are missing', () => {
    useLighterStore.setState({ currentMarketId: MARKET_ID, orderBook: NEAR_BOOK })

    expect(readMissing(OrderDirections.Long)).toEqual({
      fairPriceMissing: true,
      showPriceProtectionWarning: true,
    })
    expect(readMissing(OrderDirections.Short)).toEqual({
      fairPriceMissing: true,
      showPriceProtectionWarning: true,
    })
  })

  it('does not flag a missing fair price once mark is known', () => {
    setMarket(NEAR_BOOK)

    expect(readMissing(OrderDirections.Long)).toEqual({
      fairPriceMissing: false,
      showPriceProtectionWarning: false,
    })
  })

  it('leaves an empty own side to the no-liquidity guard', () => {
    useLighterStore.setState({
      currentMarketId: MARKET_ID,
      orderBook: { asks: [], bids: [{ price: 99.5, size: 10 }] },
    })

    expect(readMissing(OrderDirections.Long).fairPriceMissing).toBe(false)
  })

  it('does not apply to non-market order types', () => {
    useLighterStore.setState({ currentMarketId: MARKET_ID, orderBook: NEAR_BOOK })

    expect(readMissing(OrderDirections.Long, OrderType.Limit).fairPriceMissing).toBe(false)
    expect(readMissing(OrderDirections.Long, OrderType.Twap).fairPriceMissing).toBe(false)
  })
})

describe('explicit price far from fair price', () => {
  const OTHER_MARKET_ID = 1
  const NEAR_BOOK: Book = {
    asks: [{ price: 100.1, size: 10 }],
    bids: [{ price: 99.9, size: 10 }],
  }

  const far = (isShort: boolean, price: number, marketId = MARKET_ID) =>
    selectIsPriceFarFromFairPrice(useLighterStore.getState(), { marketId, isShort, price })
  const missing = (isShort: boolean, marketId = MARKET_ID) =>
    selectIsFairPriceMissing(useLighterStore.getState(), { marketId, isShort })

  beforeEach(() => {
    useLighterStore.setState({ orderBook: null, perpsMarketsStats: {}, spotMarketsStats: {} })
  })

  it('flags a price 20% through mark on either side', () => {
    setMarket(NEAR_BOOK)

    expect(far(false, 120)).toBe(true)
    expect(far(true, 80)).toBe(true)
  })

  it('accepts a price within the band of mark', () => {
    setMarket(NEAR_BOOK)

    expect(far(false, 104)).toBe(false)
    expect(far(true, 96)).toBe(false)
  })

  it('leaves a missing fair price to the fair-price-missing check', () => {
    useLighterStore.setState({ currentMarketId: MARKET_ID, orderBook: NEAR_BOOK })

    expect(far(false, 1000)).toBe(false)
    expect(missing(false)).toBe(true)
    expect(missing(true)).toBe(true)
  })

  it('does not flag a missing fair price once mark is known', () => {
    setMarket(NEAR_BOOK)

    expect(missing(false)).toBe(false)
  })

  it('leaves an empty own side to the no-liquidity guard', () => {
    setMarket({ asks: [], bids: [{ price: 99.9, size: 10 }] })

    expect(far(false, 1000)).toBe(false)
    useLighterStore.setState({ perpsMarketsStats: {} })
    expect(missing(false)).toBe(false)
  })

  it('uses the spot index as the fair price', () => {
    useLighterStore.setState({
      currentMarketId: MARKET_ID,
      orderBook: NEAR_BOOK,
      spotMarketsStats: { [MARKET_ID]: { index_price: 100 } as WsSpotMarketStats },
    })

    expect(far(false, 120)).toBe(true)
    expect(far(false, 104)).toBe(false)
    expect(missing(false)).toBe(false)
  })

  it('prices another market from its own stats, not the current book', () => {
    setMarket({ asks: [{ price: 1000, size: 10 }], bids: [{ price: 999, size: 10 }] })
    useLighterStore.setState({
      perpsMarketsStats: {
        [MARKET_ID]: { mark_price: 1000 } as WsPerpsMarketStats,
        [OTHER_MARKET_ID]: {
          mark_price: 100,
          best_ask_price: 100.1,
          best_bid_price: 99.9,
        } as WsPerpsMarketStats,
      },
    })

    expect(far(false, 120, OTHER_MARKET_ID)).toBe(true)
    expect(far(false, 104, OTHER_MARKET_ID)).toBe(false)
    expect(missing(false, OTHER_MARKET_ID)).toBe(false)
  })
})

describe('opposite side position flip', () => {
  const ACCOUNT_INDEX = 7

  const shortPosition = (size: number): Position => ({
    market_id: MARKET_ID,
    initial_margin_fraction: 500,
    sign: AccountPositionSignEnum.Short,
    position: size,
    avg_entry_price: 100,
    margin_mode: AccountPositionMarginModeEnum.Cross,
    allocated_margin: 0,
    total_funding_paid_out: 0,
    total_discount: 0,
    margin_set_flag: 0,
  })

  const usdcBalance = (amount: number): WsAssetBalance => ({
    asset_id: USDC_ASSET_ID,
    margin_mode: AccountAssetMarginModeEnum.Enabled,
    balance: amount,
    margin_balance: amount,
    locked_balance: 0,
    available_balance: amount,
    available_margin_balance: amount,
  })

  const usdcStats: WsAssetStats = { asset_id: USDC_ASSET_ID, index_price: 1, total_supplied: 0 }

  const setOrder = ({
    pinnedInput = 'percentage',
    pinnedValueInputValue = '60',
    reduceOnly = false,
  }: {
    pinnedInput?: 'percentage' | 'base'
    pinnedValueInputValue?: string
    reduceOnly?: boolean
  } = {}) => {
    setMarket({ asks: [{ price: 100.5, size: 1000 }], bids: [{ price: 99.5, size: 1000 }] })
    useLighterStore.setState((state) => ({
      accountIndex: ACCOUNT_INDEX,
      assetsStats: { [USDC_ASSET_ID]: usdcStats },
      accounts: {
        ...state.accounts,
        [ACCOUNT_INDEX]: {
          ...state.accounts[ACCOUNT_INDEX],
          activeOrders: {},
          assetBalances: { [USDC_ASSET_ID]: usdcBalance(1000) },
          positions: { [MARKET_ID]: shortPosition(0.01) },
        },
      },
      reduceOnly,
      limitPriceInputValue: '100',
      pinnedValueInputValue,
      preferences: { ...state.preferences, pinnedInput },
    }))
  }

  const read = (direction: OrderDirections, orderType: OrderType = OrderType.Market) => {
    const state = useLighterStore.getState()
    return {
      flips: selectFlipsOppositeSidePosition(state, { direction, orderType }),
      warning: selectShowOppositeSidePositionWarning(state, { direction, orderType }),
    }
  }

  it('warns for a market or twap order that flips an opposite side position', () => {
    setOrder()

    expect(read(OrderDirections.Long)).toEqual({ flips: true, warning: true })
    expect(read(OrderDirections.Long, OrderType.Twap)).toEqual({ flips: true, warning: true })
  })

  it('flags a limit order flip without the order panel warning', () => {
    setOrder()

    expect(read(OrderDirections.Long, OrderType.Limit)).toEqual({ flips: true, warning: false })
  })

  it('ignores same side, reduce only and half-slider orders', () => {
    setOrder()
    expect(read(OrderDirections.Short)).toEqual({ flips: false, warning: false })

    setOrder({ pinnedInput: 'base', pinnedValueInputValue: '1', reduceOnly: true })
    expect(read(OrderDirections.Long)).toEqual({ flips: false, warning: false })

    setOrder({ pinnedValueInputValue: '50' })
    expect(read(OrderDirections.Long)).toEqual({ flips: false, warning: false })
  })

  it('ignores an order no bigger than the position', () => {
    const flips = selectFlipsOppositeSidePosition.resultFunc
    expect(flips(false, false, shortPosition(2), '60', 2)).toBe(false)
    expect(flips(false, false, shortPosition(2), '60', 2.01)).toBe(true)
  })
})
