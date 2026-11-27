import type { StateCreator } from 'zustand'

import { OrderDirections } from '../../constants/shared'
import { OrderType, type OrderPlacementInput } from '../../types/order'

export type BOOrderType = typeof OrderType.Market | typeof OrderType.Limit

export type BOTimeInForce = 'gtt' | 'post_only' | 'ioc'

export type BOSide = 'buy' | 'sell'

export interface BOSlice {
  boSide: BOSide
  boDirection: OrderDirections
  boPinnedInput: OrderPlacementInput
  boPinnedValueInputValue: string
  boOrderType: BOOrderType
  boLimitPriceInputValue: string
  boTimeInForce: BOTimeInForce
}

export const DEFAULT_BO_SLICE: BOSlice = {
  boSide: 'buy',
  boDirection: OrderDirections.Long,
  boPinnedInput: 'quote',
  boPinnedValueInputValue: '',
  boOrderType: OrderType.Market,
  boLimitPriceInputValue: '',
  boTimeInForce: 'gtt',
}

export const createBOSlice: StateCreator<BOSlice, [], [], BOSlice> = () => ({
  ...DEFAULT_BO_SLICE,
})
