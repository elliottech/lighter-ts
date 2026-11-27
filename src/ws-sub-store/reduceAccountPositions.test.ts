import { afterEach, describe, expect, it } from 'vitest'
import { AccountPositionMarginModeEnum } from 'zklighter-perps'

import type { WsPosition } from '../lighter-ws/types/WsMessage'
import type { Account } from '../store/types'

import { type PositionUpdate, reduceAccountPositions } from './reduceAccountPositions'

const positionUpdate = (overrides: Partial<PositionUpdate> = {}): PositionUpdate => ({
  market_id: 1,
  initial_margin_fraction: 5,
  sign: 1,
  position: 2,
  avg_entry_price: 100,
  margin_mode: AccountPositionMarginModeEnum.Cross,
  allocated_margin: 0,
  margin_set_flag: 0,
  ...overrides,
})

const position = (overrides: Partial<WsPosition> = {}): WsPosition => ({
  ...positionUpdate(),
  total_funding_paid_out: 0,
  total_discount: 0,
  ...overrides,
})

const accountWith = (positions: Record<string, WsPosition>): Account => ({ positions })

const fundingKeyed = (key: string, amount: number) => {
  const funding: Record<string, number> = {}
  Object.defineProperty(funding, key, {
    value: amount,
    enumerable: true,
    writable: true,
    configurable: true,
  })
  return funding
}

const FUNDING_FIELDS = ['total_funding_paid_out', 'total_discount']

const inheritedBy = (key: string): unknown => Reflect.get({}, key)

const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

describe('reduceAccountPositions', () => {
  afterEach(() => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const inherited = inheritedBy(key)
      if (!isObjectLike(inherited)) continue
      for (const field of FUNDING_FIELDS) Reflect.deleteProperty(inherited, field)
    }
  })

  it('adds the funding round and discount to the positions the account holds', () => {
    const account = accountWith({
      '1': position({ total_funding_paid_out: 10, total_discount: 1 }),
    })

    const next = reduceAccountPositions(account, {}, { '1': 2.5, '7': 99 }, { '1': 0.5 })

    expect(next.positions).toEqual({
      '1': position({ total_funding_paid_out: 12.5, total_discount: 1.5 }),
    })
  })

  it('starts a position that closes or flips side from zero funding', () => {
    const account = accountWith({
      '1': position({ sign: 1, total_funding_paid_out: 10, total_discount: 1 }),
      '2': position({ market_id: 2, total_funding_paid_out: 4, total_discount: 2 }),
    })

    const next = reduceAccountPositions(account, {
      '1': positionUpdate({ sign: -1 }),
      '2': positionUpdate({ market_id: 2, position: 0 }),
    })

    expect(next.positions?.['1']).toEqual(
      position({ sign: -1, total_funding_paid_out: 0, total_discount: 0 }),
    )
    expect(next.positions?.['2']).toEqual(
      position({ market_id: 2, position: 0, total_funding_paid_out: 0, total_discount: 0 }),
    )
  })

  it('keeps the funding a position has built up when it changes size on the same side', () => {
    const account = accountWith({
      '1': position({ position: 2, total_funding_paid_out: 10, total_discount: 1 }),
    })

    const next = reduceAccountPositions(account, { '1': positionUpdate({ position: 5 }) })

    expect(next.positions?.['1']).toEqual(
      position({ position: 5, total_funding_paid_out: 10, total_discount: 1 }),
    )
  })

  it('opens the first position of an account with zero funding, then adds the funding sent with it', () => {
    const next = reduceAccountPositions(
      undefined,
      { '3': positionUpdate({ market_id: 3 }) },
      { '3': 1.5 },
      { '3': 0.25 },
    )

    expect(next.positions?.['3']).toEqual(
      position({ market_id: 3, total_funding_paid_out: 1.5, total_discount: 0.25 }),
    )
  })

  it('leaves the other positions and the rest of the account as they were', () => {
    const untouched = position({ market_id: 2, total_funding_paid_out: 4, total_discount: 2 })
    const account: Account = { positions: { '2': untouched }, totalVolume: 9 }

    const next = reduceAccountPositions(account, { '1': positionUpdate() }, { '1': 1 })

    expect(next.positions?.['2']).toBe(untouched)
    expect(next.totalVolume).toBe(9)
    expect(account.positions).toEqual({ '2': untouched })
  })

  it.each(['__proto__', 'constructor', 'toString'])(
    'ignores a funding update keyed %s instead of writing onto a built-in',
    (key) => {
      const account = accountWith({
        '1': position({ total_funding_paid_out: 10, total_discount: 1 }),
      })
      const funding = fundingKeyed(key, 5)

      const next = reduceAccountPositions(account, {}, funding, funding)

      for (const field of FUNDING_FIELDS) {
        expect(inheritedBy(key)).not.toHaveProperty(field)
      }
      expect(next.positions).toEqual({
        '1': position({ total_funding_paid_out: 10, total_discount: 1 }),
      })
    },
  )
})
