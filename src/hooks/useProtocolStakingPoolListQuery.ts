import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { PublicPoolsMetadataRequest } from 'zklighter-perps'
import { useLighterStore } from '../store/useLighterStore'
import { selectAccountExistence, selectUserAccountIndex } from '../store/user/selectors'
import { MAX_ACCOUNT_INDEX_LIMIT } from '../constants/shared'
import { apis } from '../lib/apis'
import { convertPublicPoolMetadata } from '../utils/restApiConversion'

export const useProtocolStakingPoolListQuery = () => {
  const accounExistence = useLighterStore(selectAccountExistence)
  const accountIndex = useLighterStore(selectUserAccountIndex)

  const params: PublicPoolsMetadataRequest = useMemo(
    () => ({
      index: MAX_ACCOUNT_INDEX_LIMIT,
      limit: 100,
      filter: 'stake',
      account_index: accounExistence === 'Exists' ? accountIndex : undefined,
    }),
    [accounExistence, accountIndex],
  )

  return useQuery({
    queryKey: ['stakingPools', params],
    queryFn: () =>
      apis.accountApi.publicPoolsMetadata(params).then(({ public_pools, ...rest }) => ({
        ...rest,
        public_pools: public_pools.map(convertPublicPoolMetadata),
      })),
    enabled: accounExistence !== 'Deciding',
    refetchInterval: 60000,
    refetchOnMount: true,
    retry: 1,
  })
}
