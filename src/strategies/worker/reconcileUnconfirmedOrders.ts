import { ENGINE_ORDER_TYPE } from '../engine/types'
import { type Order, isOrderActive, wait } from '../..'
import { creditFillDelta } from './creditOrderTradeVolumesV2'
import { fetchOrderSnapshot } from '../orderSnapshot'
import { useStrategyStore } from '../store/strategyStore'

import { SIGNED_TX_LIFETIME_MS, cancelOrderUntilTerminalState } from '../orderLifecycle'

const LOOKUP_INTERVAL_MS = 10_000

export interface UnconfirmedOrderLookup {
  order: Order
  /** A limit order's fills count as maker, as the engine would have. */
  isMaker: boolean
}

export interface UnconfirmedOrdersLookup {
  orders: UnconfirmedOrderLookup[]
  /** Set when an entry could not be looked up; that entry is kept. */
  error?: unknown
}

/**
 * Looks up, by client order index over REST, the orders a strategy had in
 * flight when its worker was lost. A found one is returned for the caller to
 * settle, which drops its entry. One the venue does not know is dropped once
 * its signed tx can no longer execute; until then it may still land, so the
 * lookup keeps polling for it (the engine must not resend that size
 * meanwhile). A failed lookup is retried the same way; once the tx can no
 * longer execute its entry is kept and the error returned beside the orders
 * found.
 */
export async function lookupUnconfirmedOrders(
  id: string,
  accountIndex: number,
): Promise<UnconfirmedOrdersLookup> {
  const unconfirmedOrders = useStrategyStore.getState().strategies[id]?.unconfirmedOrders ?? {}
  const found: UnconfirmedOrderLookup[] = []
  let lookupError: unknown
  for (const [key, unconfirmed] of Object.entries(unconfirmedOrders)) {
    const clientOrderIndex = Number(key)
    const expiresAt = unconfirmed.sentAt + SIGNED_TX_LIFETIME_MS
    let order: Order | undefined
    let failure: unknown = null
    for (;;) {
      failure = null
      try {
        order = await fetchOrderSnapshot({ accountIndex, clientOrderIndex })
      } catch (error) {
        failure = error
      }
      if (order || Date.now() >= expiresAt) break
      await wait(Math.min(LOOKUP_INTERVAL_MS, expiresAt - Date.now()))
    }
    if (failure !== null) {
      lookupError ??= failure
      continue
    }
    if (!order) {
      if (Date.now() >= expiresAt) {
        useStrategyStore.getState().removeUnconfirmedOrder(id, clientOrderIndex)
      }
      continue
    }
    found.push({
      order,
      isMaker: unconfirmed.orderType === ENGINE_ORDER_TYPE.limit,
    })
  }
  return { orders: found, error: lookupError }
}

export interface UnconfirmedOrderSettlement {
  /** Credits a terminal order's maker/taker split and drops its entry. */
  creditOrderTradeVolumes: (id: string, order: Order) => void
  report: (error: unknown, id: string, orderId?: string) => void
}

/**
 * Settles the in-flight orders of a strategy that is no longer running, so no
 * engine will own them: a resting one is cancelled, and the fills are
 * credited to the record. A failed cancel leaves the entry in place.
 */
export async function settleUnconfirmedOrders(
  id: string,
  accountIndex: number,
  unconfirmed: UnconfirmedOrderLookup[],
  settlement: UnconfirmedOrderSettlement,
): Promise<void> {
  for (const { order, isMaker } of unconfirmed) {
    try {
      const latest = isOrderActive(order)
        ? await cancelOrderUntilTerminalState({
            accountIndex,
            marketId: order.market_index,
            orderId: order.order_id,
            clientOrderIndex: order.client_order_index,
          })
        : order
      creditFillDelta(id, {
        baseDelta: latest.filled_base_amount,
        quoteDelta: latest.filled_quote_amount,
        isMaker,
      })
      settlement.creditOrderTradeVolumes(id, latest)
    } catch (error) {
      settlement.report(error, id, order.order_id)
    }
  }
}

/**
 * Looks up and settles the in-flight orders of a strategy no engine will
 * resume. Nothing resumes an aborted record, so one whose tx may still land
 * is waited for here; a lookup that keeps failing leaves its entry in place.
 */
export async function lookupAndSettleUnconfirmedOrders(
  id: string,
  accountIndex: number,
  settlement: UnconfirmedOrderSettlement,
): Promise<void> {
  const unconfirmed = await lookupUnconfirmedOrders(id, accountIndex)
  if (unconfirmed.error !== undefined) settlement.report(unconfirmed.error, id)
  await settleUnconfirmedOrders(id, accountIndex, unconfirmed.orders, settlement)
}
