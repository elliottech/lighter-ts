import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Token as ApiToken } from 'zklighter-perps'

import { type Env, currentEnv } from '../lib/env'
import { fallbackData } from '../fallbacks'

import { useInitTokens } from './useInitTokens'

const { query, tokenlist } = vi.hoisted(() => ({
  query: { options: undefined as { queryFn: () => Promise<unknown> } | undefined },
  tokenlist: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryFn: () => Promise<unknown> }) => {
    query.options = options
    return { data: undefined }
  },
}))

vi.mock('react', () => ({ useEffect: () => undefined }))

vi.mock('../lib/apis', () => ({ apis: { tokenlistApi: { tokenlist } } }))

const token = (symbol: string, backendSymbol = '') =>
  ({ symbol, backend_symbol: backendSymbol }) as unknown as ApiToken

const fetchTokens = async (env: Env) => {
  currentEnv.env = env
  const tokens = (await query.options!.queryFn()) as ApiToken[]
  return tokens.map((t) => t.backend_symbol)
}

afterEach(() => {
  currentEnv.env = null!
  fallbackData.tokens = null
})

beforeEach(() => {
  tokenlist.mockResolvedValue({ tokens: [token('ETH'), token('USDC', 'USDC.e')] })
  fallbackData.tokens = { tokens: [token('ETH'), token('USDC'), token('0G')] }
})

describe('useInitTokens', () => {
  it.each<Env>(['mainnet', 'robinhood-mainnet'])(
    'uses only the api token list on %s',
    async (env) => {
      useInitTokens()
      expect(await fetchTokens(env)).toEqual(['ETH', 'USDC.e'])
    },
  )

  it.each<Env>(['local', 'staging', 'testnet', 'robinhood-testnet'])(
    'adds fallback-only tokens to the api token list on %s',
    async (env) => {
      useInitTokens()
      expect(await fetchTokens(env)).toEqual(['ETH', 'USDC.e', '0G'])
    },
  )
})
