import type { WsPosition } from '../lighter-ws/types/WsMessage'
import type { Account } from '../store/types'

export type PositionUpdate = Omit<WsPosition, 'total_funding_paid_out' | 'total_discount'>

export const reduceAccountPositions = (
  account: Account | undefined,
  positions: Record<string, PositionUpdate>,
  lastFundingRound?: Record<string, number>,
  lastFundingDiscount?: Record<string, number>,
) => {
  const newAccount = { ...account }
  const newPositions: Record<string, WsPosition> = { ...newAccount.positions }
  newAccount.positions = newPositions

  const ownPosition = (marketId: string) =>
    Object.hasOwn(newPositions, marketId) ? newPositions[marketId] : undefined

  Object.entries(positions).forEach(([marketId, newPosition]) => {
    const oldPosition = ownPosition(marketId)

    if (!newPosition.position || (oldPosition && newPosition.sign !== oldPosition.sign)) {
      newPositions[marketId] = {
        ...newPosition,
        total_funding_paid_out: 0,
        total_discount: 0,
      }
    } else {
      newPositions[marketId] = {
        ...oldPosition,
        ...newPosition,
        total_funding_paid_out: oldPosition?.total_funding_paid_out ?? 0,
        total_discount: oldPosition?.total_discount ?? 0,
      }
    }
  })

  Object.entries(lastFundingRound ?? {}).forEach(([marketId, newFunding]) => {
    const position = ownPosition(marketId)
    if (position) position.total_funding_paid_out += newFunding
  })

  Object.entries(lastFundingDiscount ?? {}).forEach(([marketId, newDiscount]) => {
    const position = ownPosition(marketId)
    if (position) position.total_discount += newDiscount
  })
  return newAccount
}
