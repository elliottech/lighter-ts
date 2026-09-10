import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { Token as ApiToken } from 'zklighter-perps'
import { isRobinhoodEnv } from '../lib/env'
import { normalizeTokens } from '../utils/normalizeTokens'
import { INIT_DATA_REFETCH_INTERVAL } from '../utils/common'
import { useLighterStore } from '../store/useLighterStore'
import { tokensFallback } from '../fallbacks'
import { apis } from '../lib/apis'

const useTokensQuery = () =>
  useQuery({
    queryKey: ['tokenList'],
    queryFn: async () => {
      const response = await apis.tokenlistApi.tokenlist()
      const responseSymbols = new Set(
        response.tokens.flatMap((t) => [t.backend_symbol || t.symbol, t.symbol]),
      )
      const fallbackOnlyTokens = isRobinhoodEnv()
        ? []
        : (tokensFallback.tokens as ApiToken[]).filter(
            (t) =>
              !responseSymbols.has(t.backend_symbol || t.symbol) && !responseSymbols.has(t.symbol),
          )
      return normalizeTokens([...response.tokens, ...fallbackOnlyTokens])
    },
    refetchInterval: INIT_DATA_REFETCH_INTERVAL,
    staleTime: INIT_DATA_REFETCH_INTERVAL,
  })

export const useInitTokens = () => {
  const tokensQuery = useTokensQuery()

  useEffect(() => {
    if (!tokensQuery.data || tokensQuery.data.length === 0) return

    useLighterStore.setState({ tokens: tokensQuery.data })
  }, [tokensQuery.data])
}
