import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { apis } from '../lib/apis'
import { INIT_DATA_REFETCH_INTERVAL } from '../utils/common'
import { useLighterStore } from '../store/useLighterStore'

const useSystemConfigQuery = () =>
  useQuery({
    queryKey: ['systemConfig'],
    queryFn: () => apis.infoApi.systemConfig(),
    refetchInterval: INIT_DATA_REFETCH_INTERVAL,
    staleTime: INIT_DATA_REFETCH_INTERVAL,
  })

export const useInitSystemConfig = () => {
  const systemConfigQuery = useSystemConfigQuery()

  useEffect(() => {
    if (!systemConfigQuery.data) {
      return
    }

    useLighterStore.setState({ systemConfig: systemConfigQuery.data })
  }, [systemConfigQuery.data])
}
