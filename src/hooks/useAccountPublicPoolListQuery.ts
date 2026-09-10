import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { PublicPoolsMetadataRequest } from 'zklighter-perps'
import { useLighterStore } from '../store/useLighterStore'
import { selectAccountExistence, selectUserAccountIndex } from '../store/user/selectors'
import { apis } from '../lib/apis'
import { convertPublicPoolMetadata } from '../utils/restApiConversion'
import { MAX_ACCOUNT_INDEX_LIMIT } from '../constants/shared'

const PAGE_SIZE = 100

export const useAccountPublicPoolListQuery = () => {
  const isAuthed = useLighterStore(selectAccountExistence) === 'Exists'
  const accountIndex = useLighterStore(selectUserAccountIndex)
  const params: Omit<PublicPoolsMetadataRequest, 'index'> = useMemo(
    () => ({
      limit: PAGE_SIZE,
      filter: 'account_index',
      account_index: accountIndex,
    }),
    [accountIndex],
  )

  return useInfiniteQuery({
    queryKey: ['publicPools', params],
    queryFn: ({ pageParam }) =>
      apis.accountApi
        .publicPoolsMetadata({ index: pageParam, ...params })
        .then(({ public_pools, ...rest }) => ({
          ...rest,
          public_pools: public_pools.map(convertPublicPoolMetadata),
        })),
    enabled: isAuthed,
    refetchInterval: 60000,
    initialPageParam: MAX_ACCOUNT_INDEX_LIMIT,
    getNextPageParam: (lastPage) =>
      lastPage.public_pools[lastPage.public_pools.length - 1]?.account_index,
    refetchOnMount: true,
    retry: 1,
  })
}
