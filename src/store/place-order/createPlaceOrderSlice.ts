import { type StateCreator } from 'zustand'

import { type SLTPInput, OrderType } from '../../types/order'

import type { TimeInForce, TimeInForceUnit } from './utils'

export type SLTP = {
  pinnedInput: SLTPInput
  pinnedValueInputValue: string
  limitPriceInputValue: string
}

export interface PlaceOrderSlice {
  orderType: OrderType
  pinnedValueInputValue: string
  limitPriceInputValue: string
  triggerPriceInputValue: string
  timeInForce: TimeInForce
  timeInForceValue: string
  timeInForceUnit: TimeInForceUnit
  reduceOnly: boolean
  runtimeHours: string
  runtimeMinutes: string
  stopLoss: SLTP
  takeProfit: SLTP
  scale: {
    startPriceInputValue: string
    endPriceInputValue: string
    orderCountInputValue: string
    skewInputValue: string
  }
  isInputLocked: boolean
  displayedForm:
    | { type: 'placeOrder' }
    | { type: 'closePosition' }
    | { type: 'modifyPosition' }
    | { type: 'modifyOrder'; orderId: string }
}

export const DEFAULT_SLTP: SLTP = {
  pinnedInput: 'triggerPrice',
  pinnedValueInputValue: '',
  limitPriceInputValue: '',
}

export const createPlaceOrderSlice: StateCreator<
  PlaceOrderSlice,
  [],
  [],
  PlaceOrderSlice
> = () => ({
  orderType: OrderType.Market,
  pinnedValueInputValue: '',
  limitPriceInputValue: '',
  triggerPriceInputValue: '',
  timeInForce: 'gtd',
  timeInForceValue: '28',
  timeInForceUnit: 'd',
  reduceOnly: false,
  runtimeHours: '',
  runtimeMinutes: '30',
  stopLoss: DEFAULT_SLTP,
  takeProfit: DEFAULT_SLTP,
  scale: {
    startPriceInputValue: '',
    endPriceInputValue: '',
    orderCountInputValue: '',
    skewInputValue: '1.00',
  },
  isInputLocked: false,
  displayedForm: { type: 'placeOrder' },
})
