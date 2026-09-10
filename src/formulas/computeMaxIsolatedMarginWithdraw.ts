import type { Position } from '../store/types'

import { computeCollateralLockedInPosition, computePositionPnl } from './common'

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
    position.allocated_margin -
      computeCollateralLockedInPosition(
        position.position,
        position.avg_entry_price,
        position.initial_margin_fraction,
      ) +
      Math.min(0, computePositionPnl(position, markPrice)),
  )
