import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { Token as ApiToken } from 'zklighter-perps'
import { normalizeTokens } from '../utils/normalizeTokens'
import { INIT_DATA_REFETCH_INTERVAL } from '../utils/common'
import { useLighterStore } from '../store/useLighterStore'
import { fallbackData } from '../fallbacks'
import { apis } from '../lib/apis'
import { isTokenListFallbackMerged } from '../lib/env'

const useTokensQuery = () =>
  useQuery({
    queryKey: ['tokenList'],
    queryFn: async () => {
      const response = await apis.tokenlistApi.tokenlist()
      if (!isTokenListFallbackMerged()) return normalizeTokens(response.tokens)
      const responseSymbols = new Set(
        response.tokens.flatMap((t) => [t.backend_symbol || t.symbol, t.symbol]),
      )
      const fallbackOnlyTokens = ((fallbackData.tokens?.tokens ?? []) as ApiToken[]).filter(
        (t) => !responseSymbols.has(t.backend_symbol || t.symbol) && !responseSymbols.has(t.symbol),
      )
      return normalizeTokens([...response.tokens, ...fallbackOnlyTokens])
    },
    refetchInterval: INIT_DATA_REFETCH_INTERVAL,
    staleTime: INIT_DATA_REFETCH_INTERVAL,
    refetchOnWindowFocus: true,
  })

export const useInitTokens = () => {
  const tokensQuery = useTokensQuery()

  useEffect(() => {
    if (!tokensQuery.data || tokensQuery.data.length === 0) return

    useLighterStore.setState({ tokens: tokensQuery.data })
  }, [tokensQuery.data])
}
