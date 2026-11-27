import type { Clock, WorkingOrders } from './types'
import type { Order } from '../..'

export class FakeClock implements Clock {
  private _now = 0
  private timers: { id: number; at: number; fn: () => void }[] = []
  private nextId = 1

  now() {
    return this._now
  }
  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++
    // Like Node, which fires a timeout over 2^31-1 ms at once.
    this.timers.push({ id, at: this._now + (ms > 2 ** 31 - 1 ? 1 : ms), fn })
    return id
  }
  clearTimeout(handle: number | undefined): void {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }

  // ----- test helpers -----

  /** Fire the next-due pending timer (advance virtual time to it). */
  fireNext(): void {
    if (this.timers.length === 0) return
    this.timers.sort((a, b) => a.at - b.at)
    const t = this.timers.shift()!
    this._now = Math.max(this._now, t.at)
    t.fn()
  }

  advance(ms: number): void {
    this._now += ms
  }
  pendingCount(): number {
    return this.timers.length
  }
  nextDueAt(): number | null {
    if (this.timers.length === 0) return null
    return Math.min(...this.timers.map((t) => t.at))
  }
}

/** Working orders keyed by `order_id`, as persisted on a strategy record. */
export const wsWorkingOrders = (...overrides: Partial<Order>[]): WorkingOrders =>
  Object.fromEntries(
    overrides.map((o) => {
      const [order] = wsOrder(o)
      return [order.order_id, order]
    }),
  )

export const wsOrder = (overrides: Partial<Order> = {}): [Order] => [
  {
    order_id: 'auto',
    status: 'open',
    remaining_base_amount: 0,
    filled_base_amount: 0,
    filled_quote_amount: 0,
    initial_base_amount: 0,
    is_ask: false,
    market_index: 0,
    market_symbol: 'ETH',
    market_kind: 'perps',
    nonce: 0,
    owner_account_index: 0,
    price: 0,
    reduce_only: false,
    trigger_price: 0,
    order_expiry: 0,
    client_order_index: 0,
    parent_order_id: '',
    to_cancel_order_id_0: '',
    trigger_status: 'na',
    created_at: 0,
    updated_at: 0,
    type: 'limit',
    time_in_force: 'good-till-time',
    ...overrides,
  },
]
