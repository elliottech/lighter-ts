// REST lookup for a single order's latest state, used when resuming a
// persisted strategy: the working order may have filled/canceled/expired
// while no tab was open, so the ws store knows nothing about it.

import { type Order, apis, convertOrder } from '..'

/**
 * Fetches the latest known state of one order over REST by its client order
 * index (active or terminal alike). Returns undefined when the venue does not
 * know the order.
 */
export async function fetchOrderSnapshot(params: {
  accountIndex: number
  clientOrderIndex: number
}): Promise<Order | undefined> {
  const { accountIndex, clientOrderIndex } = params

  const { orders } = await apis.orderApi.accountOrders({
    account_index: accountIndex,
    client_order_indexes: String(clientOrderIndex),
  })
  const [match] = orders

  return match ? convertOrder(match) : undefined
}
