import { useQuery } from '@tanstack/react-query'
import { keyBy, mapValues, pick } from 'lodash-es'
import { useEffect } from 'react'
import { getDisplayDecimals } from '../utils/multiplier'
import type { AssetMeta } from '../types/compatibility'
import { ASSET_FIELDS } from '../constants/pickedFields'
import { INIT_DATA_REFETCH_INTERVAL } from '../utils/common'
import { useLighterStore } from '../store/useLighterStore'
import { selectDisplaySymbols } from '../store/tokens/selectors'
import { withDisplaySymbol } from '../utils/withDisplaySymbol'
import { apis } from '../lib/apis'

const useAssetMetasQuery = () =>
  useQuery({
    queryKey: ['assetDetails'],
    queryFn: async () => {
      const { asset_details } = await apis.orderApi.assetDetails()

      return keyBy(
        asset_details.map(({ decimals, ...rest }) => {
          const detail = {
            ...rest,
            size_decimals: decimals,
          }

          return pick({ ...detail, ...getDisplayDecimals(detail) }, ASSET_FIELDS) as Omit<
            AssetMeta,
            'backend_symbol'
          >
        }),
        'asset_id',
      )
    },
    refetchInterval: INIT_DATA_REFETCH_INTERVAL,
    staleTime: INIT_DATA_REFETCH_INTERVAL,
  })

export const useInitAssetMetas = () => {
  const assetMetasQuery = useAssetMetasQuery()
  const displaySymbols = useLighterStore(selectDisplaySymbols)

  useEffect(() => {
    if (!assetMetasQuery.data) return

    useLighterStore.setState({
      assetMetas: mapValues(assetMetasQuery.data, (meta) =>
        withDisplaySymbol(meta, displaySymbols),
      ),
      assetMetasLoaded: true,
    })
  }, [assetMetasQuery.data, displaySymbols])
}
