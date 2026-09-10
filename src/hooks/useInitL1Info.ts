import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { INIT_DATA_REFETCH_INTERVAL } from '../utils/common'
import { useLighterStore } from '../store/useLighterStore'
import { apis } from '../lib/apis'

const useL1InfoQuery = () =>
  useQuery({
    queryKey: ['l1Info'],
    queryFn: () => apis.infoApi.layer1BasicInfo(),
    refetchInterval: INIT_DATA_REFETCH_INTERVAL,
    staleTime: INIT_DATA_REFETCH_INTERVAL,
  })

export const useInitL1Info = () => {
  const l1InfoQuery = useL1InfoQuery()

  useEffect(() => {
    if (!l1InfoQuery.data) return

    useLighterStore.setState({ l1Info: l1InfoQuery.data })
  }, [l1InfoQuery.data])
}
