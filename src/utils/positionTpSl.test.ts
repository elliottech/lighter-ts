import { OrderTriggerStatusEnum, OrderTypeEnum } from 'zklighter-perps'
import { describe, expect, it } from 'vitest'

import type { Order } from '../store/types'
import { isSizedTpSlOrder, isWholePositionTpSlOrder } from './positionTpSl'

const order = (over: Partial<Order>) =>
  ({
    type: OrderTypeEnum.StopLoss,
    trigger_status: OrderTriggerStatusEnum.MarkPrice,
    initial_base_amount: 0,
    is_ask: true,
    ...over,
  }) as Order

describe('isWholePositionTpSlOrder', () => {
  it('is an armed tp/sl with no size', () => {
    expect(isWholePositionTpSlOrder(order({}))).toBe(true)
  })

  it('is not a sized tp/sl', () => {
    expect(isWholePositionTpSlOrder(order({ initial_base_amount: 5 }))).toBe(false)
  })

  it('is not an unsized child still waiting on its parent', () => {
    expect(
      isWholePositionTpSlOrder(order({ trigger_status: OrderTriggerStatusEnum.ParentOrder })),
    ).toBe(false)
  })
})

describe('isSizedTpSlOrder', () => {
  it('is an armed sized tp/sl that closes the position', () => {
    expect(isSizedTpSlOrder(order({ initial_base_amount: 5 }), true)).toBe(true)
    expect(isSizedTpSlOrder(order({ initial_base_amount: 5, is_ask: false }), false)).toBe(true)
  })

  it('is a triggered tp/sl limit resting on the book', () => {
    const triggered = order({
      type: OrderTypeEnum.TakeProfitLimit,
      trigger_status: OrderTriggerStatusEnum.Na,
      initial_base_amount: 5,
    })

    expect(isSizedTpSlOrder(triggered, true)).toBe(true)
  })

  it('is not a whole-position tp/sl', () => {
    expect(isSizedTpSlOrder(order({}), true)).toBe(false)
  })

  it('is not a child still waiting on its parent', () => {
    const child = order({ trigger_status: OrderTriggerStatusEnum.ParentOrder })

    expect(isSizedTpSlOrder(child, true)).toBe(false)
  })

  it('is not a tp/sl on the side that adds to the position', () => {
    expect(isSizedTpSlOrder(order({ initial_base_amount: 5 }), false)).toBe(false)
  })

  it('is not a plain limit order', () => {
    expect(
      isSizedTpSlOrder(
        order({ type: OrderTypeEnum.Limit, trigger_status: OrderTriggerStatusEnum.Na }),
        true,
      ),
    ).toBe(false)
  })
})
