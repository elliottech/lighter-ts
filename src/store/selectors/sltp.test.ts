import { AccountPositionSignEnum } from 'zklighter-perps'
import { beforeEach, describe, expect, it } from 'vitest'

import { OrderDirections } from '../../constants/shared'
import { OrderType } from '../../types/order'
import { DEFAULT_SLTP, type SLTP } from '../place-order/createPlaceOrderSlice'
import { useLighterStore } from '../useLighterStore'
import { selectIsMarketPreIpo, selectShowPreIpoSLTPWarning, selectStopLossInfo } from './sltp'

const ACCOUNT_INDEX = 7
const MARKET_ID = 0
const PRE_IPO_SYMBOL = 'PREIPO'

const market = {
  market_id: MARKET_ID,
  backend_symbol: PRE_IPO_SYMBOL,
  symbol: PRE_IPO_SYMBOL,
  market_type: 'perp',
  multiplier: '1',
  price_decimals: 2,
  size_decimals: 4,
  display_price_decimals: 2,
  display_size_decimals: 4,
  min_base_amount: '0.01',
  min_quote_amount: '10',
  order_quote_limit: '1000000',
  default_initial_margin_fraction: 500,
  min_initial_margin_fraction: 500,
}

type StoreState = ReturnType<typeof useLighterStore.getState>

const preIpoToken = {
  backend_symbol: PRE_IPO_SYMBOL,
  categories: ['PRE_IPO'],
  is_allowed_mainnet: true,
} as unknown as NonNullable<StoreState['tokens']>[number]

const regularToken = {
  backend_symbol: 'ETH',
  categories: [],
  is_allowed_mainnet: true,
} as unknown as NonNullable<StoreState['tokens']>[number]

type SetUpParams = {
  isPreIpoMarket?: boolean
  orderType?: OrderType
  stopLoss?: SLTP
  takeProfit?: SLTP
  triggerPriceInputValue?: string
  limitPriceInputValue?: string
  preIpoSLTPWarningAcknowledged?: boolean
}

const sltp = (trigger: string, limit: string): SLTP => ({
  ...DEFAULT_SLTP,
  pinnedInput: 'triggerPrice',
  pinnedValueInputValue: trigger,
  limitPriceInputValue: limit,
})

const setUp = ({
  isPreIpoMarket = true,
  orderType = OrderType.Market,
  stopLoss = DEFAULT_SLTP,
  takeProfit = DEFAULT_SLTP,
  triggerPriceInputValue = '',
  limitPriceInputValue = '',
  preIpoSLTPWarningAcknowledged = false,
}: SetUpParams = {}) =>
  useLighterStore.setState(
    (prevState) =>
      ({
        accountIndex: ACCOUNT_INDEX,
        currentMarketId: MARKET_ID,
        perpsOrderBookMetas: {
          [MARKET_ID]: {
            ...market,
            backend_symbol: isPreIpoMarket ? PRE_IPO_SYMBOL : 'ETH',
          },
        },
        perpsMarketsStats: { [MARKET_ID]: { market_id: MARKET_ID, mark_price: 100 } },
        orderBook: {
          asks: [{ price: 100.1, size: 100 }],
          bids: [{ price: 99.9, size: 100 }],
        },
        accounts: {
          [ACCOUNT_INDEX]: {
            positions: {
              [MARKET_ID]: {
                market_id: MARKET_ID,
                sign: AccountPositionSignEnum.Long,
                position: 1,
                avg_entry_price: 100,
              },
            },
          },
        },
        tokens: [preIpoToken, regularToken],
        displayedForm: { type: 'placeOrder' },
        pinnedValueInputValue: '10',
        triggerPriceInputValue,
        limitPriceInputValue,
        stopLoss,
        takeProfit,
        reduceOnly: false,
        preferences: {
          ...prevState.preferences,
          orderType,
          orderDirection: OrderDirections.Long,
          pinnedInput: 'base',
          conditionalLimitPrefill: false,
          preIpoSLTPWarningAcknowledged,
        },
      }) as unknown as Partial<StoreState>,
  )

const showWarning = () => selectShowPreIpoSLTPWarning(useLighterStore.getState())

describe('selectIsMarketPreIpo', () => {
  beforeEach(() => setUp())

  it('returns true for a pre-IPO market', () => {
    expect(selectIsMarketPreIpo(useLighterStore.getState(), { marketId: MARKET_ID })).toBe(true)
  })

  it('returns false for a non-pre-IPO market', () => {
    setUp({ isPreIpoMarket: false })

    expect(selectIsMarketPreIpo(useLighterStore.getState(), { marketId: MARKET_ID })).toBe(false)
  })

  it('returns false for an unknown market id', () => {
    expect(selectIsMarketPreIpo(useLighterStore.getState(), { marketId: 999 })).toBe(false)
  })
})

describe('selectShowPreIpoSLTPWarning', () => {
  beforeEach(() => setUp())

  it('shows the warning for a market order with a stop loss trigger and no limit', () => {
    setUp({ stopLoss: sltp('95', '') })

    const state = useLighterStore.getState()
    expect(selectStopLossInfo(state).limitPriceInputValue).toBe('')
    expect(selectStopLossInfo(state).limitPrice).toBe(0)
    expect(selectShowPreIpoSLTPWarning(state)).toBe(true)
  })

  it('shows the warning for a limit order with a take profit trigger and no limit', () => {
    setUp({
      orderType: OrderType.Limit,
      takeProfit: sltp('110', ''),
    })

    expect(showWarning()).toBe(true)
  })

  it('does not show the warning when the stop loss has a limit price', () => {
    setUp({ stopLoss: sltp('95', '94') })

    expect(showWarning()).toBe(false)
  })

  it('does not show the warning when there is no stop loss or take profit', () => {
    setUp({ stopLoss: sltp('', ''), takeProfit: sltp('', '') })

    expect(showWarning()).toBe(false)
  })

  it('does not show the warning after it was acknowledged', () => {
    setUp({
      stopLoss: sltp('95', ''),
      preIpoSLTPWarningAcknowledged: true,
    })

    expect(showWarning()).toBe(false)
  })

  it('shows the warning for a conditional order with a trigger and no limit', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '95',
      limitPriceInputValue: '',
    })

    expect(showWarning()).toBe(true)
  })

  it('does not show the warning for a conditional order with a trigger and a limit', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '95',
      limitPriceInputValue: '96',
    })

    expect(showWarning()).toBe(false)
  })

  it('does not show the warning for TWAP orders', () => {
    setUp({
      orderType: OrderType.Twap,
      stopLoss: sltp('95', ''),
    })

    expect(showWarning()).toBe(false)
  })

  it('does not show the warning for a market stop loss on a non-pre-IPO market', () => {
    setUp({
      isPreIpoMarket: false,
      stopLoss: sltp('95', ''),
    })

    expect(showWarning()).toBe(false)
  })
})
