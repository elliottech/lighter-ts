import type { OrderDirections } from '../constants/shared'
import { selectOrderBookLoading } from '../store/orderbook/selectors'
import {
  selectInvalidStopLossPriceText,
  selectInvalidTakeProfitPriceText,
} from '../store/selectors/sltp'
import {
  selectIsPlaceOrderSizeInvalid,
  selectIsReduceOnlyInvalid,
  selectNotEnoughMargin,
} from '../store/selectors/validation'
import { useLighterStore } from '../store/useLighterStore'
import { selectIsMarketDataLive } from '../ws-sub-store/selectIsMarketDataLive'
import { useWsSubStore } from '../ws-sub-store/useWsSubStore'

type UseIsPlaceOrderDisabledParams = {
  direction?: OrderDirections
  isAdvancedTWAP?: boolean
  includeSLTP?: boolean
}

export const useIsPlaceOrderDisabled = ({
  direction,
  isAdvancedTWAP = false,
  includeSLTP = true,
}: UseIsPlaceOrderDisabledParams = {}) => {
  const isSizeInvalid = useLighterStore((state) =>
    selectIsPlaceOrderSizeInvalid(state, {
      direction,
      isAdvancedTWAP,
    }),
  )
  const isStopLossInvalid = !!useLighterStore((state) =>
    selectInvalidStopLossPriceText(state, { direction }),
  )
  const isTakeProfitInvalid = !!useLighterStore((state) =>
    selectInvalidTakeProfitPriceText(state, { direction }),
  )
  const isReduceOnlyInvalid = useLighterStore((state) =>
    selectIsReduceOnlyInvalid(state, { direction }),
  )
  const notEnoughMargin = useLighterStore((state) => selectNotEnoughMargin(state, { direction }))
  const isOrderBookLoading = useLighterStore(selectOrderBookLoading)
  const isMarketDataLive = useWsSubStore(selectIsMarketDataLive)

  return (
    isSizeInvalid ||
    (includeSLTP && (isStopLossInvalid || isTakeProfitInvalid)) ||
    isReduceOnlyInvalid ||
    notEnoughMargin ||
    isOrderBookLoading ||
    !isMarketDataLive
  )
}
