import type { StateCreator } from 'zustand'

export type AgentExchangeStatus = 'sending' | 'thinking' | 'answered' | 'failed'

export interface AgentExchange {
  id: string
  question: string
  answer: string | null
  error: string | null
  status: AgentExchangeStatus
  askedAt: number
  answeredAt: number | null
}

export interface AgentThread {
  exchanges: AgentExchange[]
  isUnauthorized: boolean
}

export interface AgentSlice {
  agentThreads: Record<number, AgentThread>
}

export const EMPTY_AGENT_THREAD: AgentThread = { exchanges: [], isUnauthorized: false }

export const createAgentSlice: StateCreator<AgentSlice, [], [], AgentSlice> = () => ({
  agentThreads: {},
})
