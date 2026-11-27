import { AccountPositionSignEnum } from 'zklighter-perps'
import { beforeEach, describe, expect, it } from 'vitest'

import { OrderDirections } from '../../constants/shared'
import { OrderType } from '../../types/order'
import { DEFAULT_SLTP, type SLTP } from '../place-order/createPlaceOrderSlice'
import { useLighterStore } from '../useLighterStore'
import {
  selectShowEntryPriceProtectionWarning,
  selectShowLimitPriceProtectionWarning,
  selectShowPriceProtectionWarning,
  selectShowTriggerLimitPriceProtectionWarning,
} from './placeOrder'

const ACCOUNT_INDEX = 7
const MARKET_ID = 0

const market = {
  market_id: MARKET_ID,
  symbol: 'ETH',
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

type SetUpParams = {
  orderType?: OrderType
  closePositionOrderType?: OrderType
  orderDirection?: OrderDirections
  displayedForm?: 'placeOrder' | 'closePosition'
  limitPriceInputValue?: string
  triggerPriceInputValue?: string
  stopLoss?: SLTP
  takeProfit?: SLTP
  maxSLTPSlippage?: number
  asks?: { price: number; size: number }[]
  scale?: { startPriceInputValue: string; endPriceInputValue: string; orderCountInputValue: string }
}

const setUp = ({
  orderType = OrderType.Limit,
  closePositionOrderType = OrderType.Limit,
  orderDirection = OrderDirections.Long,
  displayedForm = 'placeOrder',
  limitPriceInputValue = '',
  triggerPriceInputValue = '',
  stopLoss = DEFAULT_SLTP,
  takeProfit = DEFAULT_SLTP,
  maxSLTPSlippage = 1,
  asks = [{ price: 100.1, size: 100 }],
  scale,
}: SetUpParams = {}) =>
  useLighterStore.setState(
    (prevState) =>
      ({
        accountIndex: ACCOUNT_INDEX,
        currentMarketId: MARKET_ID,
        perpsOrderBookMetas: { [MARKET_ID]: market },
        perpsMarketsStats: { [MARKET_ID]: { market_id: MARKET_ID, mark_price: 100 } },
        orderBook: {
          asks,
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
        displayedForm: { type: displayedForm },
        pinnedValueInputValue: '10',
        limitPriceInputValue,
        triggerPriceInputValue,
        stopLoss,
        takeProfit,
        scale: { ...prevState.scale, ...scale },
        reduceOnly: false,
        preferences: {
          ...prevState.preferences,
          orderType,
          closePositionOrderType,
          orderDirection,
          pinnedInput: 'base',
          maxSLTPSlippage,
        },
      }) as unknown as Partial<ReturnType<typeof useLighterStore.getState>>,
  )

const showWarning = () => selectShowPriceProtectionWarning(useLighterStore.getState())

describe('limit close price protection', () => {
  beforeEach(() => setUp())

  it('flags a limit close that sells a long far below the bids', () => {
    setUp({ displayedForm: 'closePosition', limitPriceInputValue: '9' })
    expect(showWarning()).toBe(true)
  })

  it('accepts a limit close near the book', () => {
    setUp({ displayedForm: 'closePosition', limitPriceInputValue: '99' })
    expect(showWarning()).toBe(false)
  })

  it('ignores the order form SL/TP, which a close never sends', () => {
    const stopLoss: SLTP = {
      pinnedInput: 'triggerPrice',
      pinnedValueInputValue: '105',
      limitPriceInputValue: '1050',
    }
    setUp({
      stopLoss,
      displayedForm: 'closePosition',
      closePositionOrderType: OrderType.Market,
    })
    expect(showWarning()).toBe(false)

    setUp({ stopLoss, displayedForm: 'closePosition', limitPriceInputValue: '99' })
    expect(showWarning()).toBe(false)
  })
})

describe('order modify price protection with the close form open', () => {
  const chartDrag = (limitPriceInputValue: string, displayedForm?: { type: 'placeOrder' }) =>
    selectShowLimitPriceProtectionWarning(useLighterStore.getState(), {
      orderType: OrderType.Limit,
      direction: OrderDirections.Long,
      limitPriceInputValue,
      displayedForm,
    })

  it('checks a resting buy against the asks only when the place-order form is passed', () => {
    setUp({ displayedForm: 'closePosition' })
    expect(chartDrag('110')).toBe(false)
    expect(chartDrag('110', { type: 'placeOrder' })).toBe(true)
    expect(chartDrag('100', { type: 'placeOrder' })).toBe(false)
  })
})

describe('limit price protection against an empty ask side', () => {
  const buyLimit = (limitPriceInputValue: string) =>
    selectShowLimitPriceProtectionWarning(useLighterStore.getState(), {
      orderType: OrderType.Limit,
      direction: OrderDirections.Long,
      limitPriceInputValue,
      displayedForm: { type: 'placeOrder' },
    })

  it('checks a buy against the mark price alone when there are no asks', () => {
    setUp({ asks: [] })
    expect(buyLimit('101')).toBe(false)
    expect(buyLimit('106')).toBe(true)
  })

  it('still flags a buy far above an ask below the mark price', () => {
    setUp({ asks: [{ price: 90, size: 100 }] })
    expect(buyLimit('95')).toBe(true)
  })

  it('checks a scale buy against the mark price alone when there are no asks', () => {
    const scaleBuy = (endPriceInputValue: string) => {
      setUp({
        orderType: OrderType.Scale,
        asks: [],
        scale: { startPriceInputValue: '100', endPriceInputValue, orderCountInputValue: '2' },
      })
      return selectShowEntryPriceProtectionWarning(useLighterStore.getState())
    }

    expect(scaleBuy('104')).toBe(false)
    expect(scaleBuy('106')).toBe(true)
  })
})

describe('trigger limit price protection', () => {
  it('flags a stop-limit buy whose limit is far above its trigger', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '105',
      limitPriceInputValue: '1050',
    })
    expect(showWarning()).toBe(true)
  })

  it('flags a stop-limit sell whose limit is far below its trigger', () => {
    setUp({
      orderType: OrderType.Conditional,
      orderDirection: OrderDirections.Short,
      triggerPriceInputValue: '95',
      limitPriceInputValue: '9.5',
    })
    expect(showWarning()).toBe(true)
  })

  it('accepts a stop-limit within the band of its trigger', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '105',
      limitPriceInputValue: '106',
    })
    expect(showWarning()).toBe(false)
  })

  it('flags an attached stop loss whose limit is far through its trigger', () => {
    setUp({
      orderType: OrderType.Market,
      stopLoss: {
        pinnedInput: 'triggerPrice',
        pinnedValueInputValue: '95',
        limitPriceInputValue: '9.5',
      },
    })
    expect(showWarning()).toBe(true)
  })

  it('flags an attached take profit whose limit is far through its trigger', () => {
    setUp({
      orderType: OrderType.Limit,
      limitPriceInputValue: '100',
      orderDirection: OrderDirections.Short,
      takeProfit: {
        pinnedInput: 'triggerPrice',
        pinnedValueInputValue: '90',
        limitPriceInputValue: '900',
      },
    })
    expect(showWarning()).toBe(true)
  })

  it('accepts attached SL/TP limits within the band of their triggers', () => {
    setUp({
      orderType: OrderType.Market,
      stopLoss: {
        pinnedInput: 'triggerPrice',
        pinnedValueInputValue: '95',
        limitPriceInputValue: '94',
      },
      takeProfit: {
        pinnedInput: 'triggerPrice',
        pinnedValueInputValue: '110',
        limitPriceInputValue: '109',
      },
    })
    expect(showWarning()).toBe(false)
  })

  it('flags a stop-limit 6% through its trigger even when the SL/TP slippage is higher', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '100',
      limitPriceInputValue: '106',
      maxSLTPSlippage: 8,
    })
    expect(showWarning()).toBe(true)
  })

  it('flags an attached stop loss 6% through its trigger even when the SL/TP slippage is higher', () => {
    setUp({
      orderType: OrderType.Market,
      maxSLTPSlippage: 8,
      stopLoss: {
        pinnedInput: 'triggerPrice',
        pinnedValueInputValue: '95',
        limitPriceInputValue: '89.3',
      },
    })
    expect(showWarning()).toBe(true)
  })

  it('accepts a stop-limit exactly 5% through its trigger', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '100',
      limitPriceInputValue: '105',
      maxSLTPSlippage: 8,
    })
    expect(showWarning()).toBe(false)
  })

  it.each([
    ['buy', '96.60', '101.43'],
    ['sell', '96.60', '91.77'],
  ])(
    'accepts a %s stop-limit exactly 5% from a trigger that is not a round number',
    (side, trigger, limit) => {
      setUp({
        orderType: OrderType.Conditional,
        orderDirection: side === 'sell' ? OrderDirections.Short : OrderDirections.Long,
        triggerPriceInputValue: trigger,
        limitPriceInputValue: limit,
      })
      expect(showWarning()).toBe(false)
    },
  )

  it('flags a buy stop-limit one tick past 5% from a trigger that is not a round number', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '96.60',
      limitPriceInputValue: '101.44',
    })
    expect(showWarning()).toBe(true)
  })

  it('flags a stop-limit one tick past 5% through its trigger', () => {
    setUp({
      orderType: OrderType.Conditional,
      triggerPriceInputValue: '100',
      limitPriceInputValue: '105.01',
    })
    expect(showWarning()).toBe(true)
  })
})

describe('entry and trigger price protection reasons', () => {
  const reasons = () => {
    const state = useLighterStore.getState()
    return {
      entry: selectShowEntryPriceProtectionWarning(state),
      trigger: selectShowTriggerLimitPriceProtectionWarning(state),
    }
  }

  it('flags both an entry far from mark and its stop loss limit far from the trigger', () => {
    setUp({
      limitPriceInputValue: '120',
      stopLoss: {
        pinnedInput: 'triggerPrice',
        pinnedValueInputValue: '95',
        limitPriceInputValue: '9.5',
      },
    })
    expect(reasons()).toEqual({ entry: true, trigger: true })
  })

  it('flags only the trigger when the entry is near mark', () => {
    setUp({
      limitPriceInputValue: '100',
      stopLoss: {
        pinnedInput: 'triggerPrice',
        pinnedValueInputValue: '95',
        limitPriceInputValue: '9.5',
      },
    })
    expect(reasons()).toEqual({ entry: false, trigger: true })
  })

  it('flags only the entry when no attached limit is far from its trigger', () => {
    setUp({ limitPriceInputValue: '120' })
    expect(reasons()).toEqual({ entry: true, trigger: false })
  })
})
