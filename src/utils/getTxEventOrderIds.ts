import type { TxEventInfo } from '../types/api-types'

export const getTxEventOrderIds = (eventInfo: Pick<TxEventInfo, 'i' | 'to'>): string[] =>
  `${eventInfo.to ? eventInfo.to.i : eventInfo.i}`.split(',')
