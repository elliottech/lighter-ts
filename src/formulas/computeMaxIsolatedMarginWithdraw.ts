import type { Position } from '../store/types'

import { computeMarginReq, computePositionPnl } from './common'

// returns how much collateral can be moved from isolated into cross
export const computeMaxIsolatedMarginWithdraw = (
  position: Pick<
    Position,
    'position' | 'avg_entry_price' | 'initial_margin_fraction' | 'allocated_margin' | 'sign'
  >,
  markPrice: number,
) =>
  Math.max(
    0,
    Math.min(
      position.allocated_margin,
      position.allocated_margin +
        computePositionPnl(position, markPrice) -
        computeMarginReq(position.position, markPrice, position.initial_margin_fraction),
    ),
  )
