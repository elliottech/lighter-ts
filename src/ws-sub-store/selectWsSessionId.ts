import type { WsSubStore } from './useWsSubStore'

export const selectWsSessionId = (state: WsSubStore) => state.wsSessionId
