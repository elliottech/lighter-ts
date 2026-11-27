import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { FeeTiersFilterEnum } from 'zklighter-perps'
import { apis } from '../lib/apis'
import { INIT_DATA_REFETCH_INTERVAL } from '../utils/common'
import { useLighterStore } from '../store/useLighterStore'

const useFeeTiersQuery = () =>
  useQuery({
    queryKey: ['feeTiers'],
    queryFn: () => apis.accountApi.feeTiers({ filter: FeeTiersFilterEnum.All }),
    refetchInterval: INIT_DATA_REFETCH_INTERVAL,
    staleTime: INIT_DATA_REFETCH_INTERVAL,
  })

export const useInitFeeTiers = () => {
  const feeTiersQuery = useFeeTiersQuery()

  useEffect(() => {
    if (!feeTiersQuery.data) {
      return
    }

    useLighterStore.setState({ feeTiers: feeTiersQuery.data })
  }, [feeTiersQuery.data])
}
