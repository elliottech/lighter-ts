import { useQuery } from '@tanstack/react-query'
import { keyBy, mapValues, pick } from 'lodash-es'
import { useEffect } from 'react'
import { getDisplayDecimals } from '../utils/multiplier'
import { PERPS_OB_FIELDS, SPOT_OB_FIELDS } from '../constants/pickedFields'
import type { PerpsOrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'
import { INIT_DATA_REFETCH_INTERVAL } from '../utils/common'
import { useLighterStore } from '../store/useLighterStore'
import { selectDisplaySymbols } from '../store/tokens/selectors'
import { withDisplaySymbol } from '../utils/withDisplaySymbol'
import { apis } from '../lib/apis'

const useOrderBookMetasQuery = () =>
  useQuery({
    queryKey: ['orderBookDetails'],
    queryFn: async () => {
      const { spot_order_book_details, order_book_details } = await apis.orderApi.orderBookDetails()
      return {
        spotOrderBookMetas: keyBy(
          spot_order_book_details.map(
            (detail) =>
              pick(
                {
                  ...detail,
                  ...getDisplayDecimals(detail),
                },
                SPOT_OB_FIELDS,
              ) as Omit<SpotOrderBookDetail, 'backend_symbol'>,
          ),
          'market_id',
        ),
        perpsOrderBookMetas: keyBy(
          order_book_details.map(
            (detail) =>
              pick(
                {
                  ...detail,
                  ...getDisplayDecimals(detail),
                },
                PERPS_OB_FIELDS,
              ) as Omit<PerpsOrderBookDetail, 'backend_symbol'>,
          ),
          'market_id',
        ),
      }
    },
    refetchInterval: INIT_DATA_REFETCH_INTERVAL,
    staleTime: INIT_DATA_REFETCH_INTERVAL,
  })

export const useInitOrderBookMetas = () => {
  const orderBookMetasQuery = useOrderBookMetasQuery()
  const displaySymbols = useLighterStore(selectDisplaySymbols)

  useEffect(() => {
    if (!orderBookMetasQuery.data) return

    useLighterStore.setState({
      perpsOrderBookMetas: mapValues(orderBookMetasQuery.data.perpsOrderBookMetas, (meta) =>
        withDisplaySymbol(meta, displaySymbols),
      ),
      spotOrderBookMetas: mapValues(orderBookMetasQuery.data.spotOrderBookMetas, (meta) =>
        withDisplaySymbol(meta, displaySymbols),
      ),
      orderBookMetasLoaded: true,
    })
  }, [orderBookMetasQuery.data, displaySymbols])
}
