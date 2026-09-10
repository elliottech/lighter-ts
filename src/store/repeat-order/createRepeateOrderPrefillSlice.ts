import type { StateCreator } from 'zustand'
import type { OrderHistoryRow } from '../../types/OrderHistoryRow'

export interface RepeatOrderPrefillSlice {
  pendingRepeatOrder: OrderHistoryRow | null
}

export const selectPendingRepeatOrder = (state: RepeatOrderPrefillSlice) => state.pendingRepeatOrder

export const createRepeatOrderPrefillSlice: StateCreator<
  RepeatOrderPrefillSlice,
  [],
  [],
  RepeatOrderPrefillSlice
> = () => ({
  pendingRepeatOrder: null,
})
