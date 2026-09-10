import { selectAccountIndex } from '../params/selectors'
import { createSelector } from '../utils/createSelector'
import { createTracking } from '../utils/tracking'
import { EMPTY_AGENT_THREAD, type AgentSlice } from './createAgentSlice'

const selectAgentThreads = (state: AgentSlice) => state.agentThreads

const selectAgentThread = createSelector(
  [selectAgentThreads, selectAccountIndex],
  createTracking(
    'selectAgentThread',
    (agentThreads, accountIndex) => agentThreads[accountIndex] ?? EMPTY_AGENT_THREAD,
  ),
)

export const selectAgentExchanges = createSelector(
  [selectAgentThread],
  createTracking('selectAgentExchanges', (thread) => thread.exchanges),
)

export const selectIsAgentUnauthorized = createSelector(
  [selectAgentThread],
  createTracking('selectIsAgentUnauthorized', (thread) => thread.isUnauthorized),
)
