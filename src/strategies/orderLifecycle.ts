import {
  ApiError,
  type CancelOrderParams,
  type CreateOrderParams,
  type ModifyOrderParams,
  type Order,
  StrategyOrderKind,
  convertFloatToBase,
  createSelector,
  isOrderActive,
  selectActiveOrdersByMarketId,
  selectInactiveOrdersByMarketId,
  selectOrderBookMeta,
  transactionConfig,
  useLighterStore,
} from '..'
import { UnconfirmedOrderError, isNonRetryableOrderError } from './engine/errors'
import { cancelOrder, createOrder, modifyOrder } from '../transactions'
import { fetchOrderSnapshot } from './orderSnapshot'

const ORDER_CONFIRMATION_TIMEOUT_MS = 10_000
// A signed tx can still execute until its ExpiredAt, 10 minutes after signing;
// the extra minute covers clock skew with the committer.
export const SIGNED_TX_LIFETIME_MS = 11 * 60_000

const selectMarketOrders = createSelector(
  [
    selectActiveOrdersByMarketId,
    selectInactiveOrdersByMarketId,
    (_, { clientOrderIndex }: { clientOrderIndex: number }) => clientOrderIndex,
  ],
  (active = [], inactive = [], clientOrderIndex) =>
    [...active, ...inactive].find((order) => order.client_order_index === clientOrderIndex),
)

/** The venue's last lookup found no such order. */
class OrderNotFoundError extends Error {
  name = 'OrderNotFoundError'
}

type WaitForOrderByClientIndexParams = {
  accountIndex: number
  marketId: number
  clientOrderIndex: number
}

const watchOrderByClientIndex = (
  { accountIndex, marketId, clientOrderIndex }: WaitForOrderByClientIndexParams,
  predicate: (order: Order) => boolean,
  timeoutMs = ORDER_CONFIRMATION_TIMEOUT_MS,
): Promise<Order> => {
  let unsubscribe = () => {}
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let remainingLookups = Math.ceil(timeoutMs / ORDER_CONFIRMATION_TIMEOUT_MS)

  return new Promise<Order>((resolve, reject) => {
    const settle = (order: Order | null, error: unknown) => {
      if (settled) {
        return
      }

      settled = true
      unsubscribe()
      clearTimeout(fallbackTimer)
      if (order) {
        resolve(order)
      } else {
        reject(error)
      }
    }

    unsubscribe = useLighterStore.subscribe(
      (state) => selectMarketOrders(state, { accountIndex, marketId, clientOrderIndex }),
      (order) => {
        if (order && predicate(order)) {
          settle(order, undefined)
        }
      },
      { fireImmediately: true },
    )

    // fireImmediately can settle synchronously, before `unsubscribe` and the
    // fallback timer exist — release the subscription and skip the fallback.
    if (settled) {
      unsubscribe()
      return
    }

    const lookUp = async () => {
      remainingLookups--
      const lookup = await fetchOrderSnapshot({
        accountIndex,
        clientOrderIndex,
      }).then(
        (snapshot) => ({ snapshot, error: undefined }),
        (error: unknown) => ({ snapshot: undefined, error }),
      )

      if (settled) {
        return
      }

      if (lookup.snapshot && predicate(lookup.snapshot)) {
        settle(lookup.snapshot, undefined)
      } else if (remainingLookups <= 0) {
        const message = `Order ${clientOrderIndex} not confirmed within ${timeoutMs}ms`
        settle(
          null,
          lookup.error ?? (lookup.snapshot ? new Error(message) : new OrderNotFoundError(message)),
        )
      } else {
        fallbackTimer = setTimeout(lookUp, ORDER_CONFIRMATION_TIMEOUT_MS)
      }
    }

    fallbackTimer = setTimeout(lookUp, ORDER_CONFIRMATION_TIMEOUT_MS)
  })
}

const isDefinitiveRejection = (error: unknown) =>
  error instanceof ApiError && error.code !== undefined

export const createOrderUntil = async (
  {
    strategyOrderKind = StrategyOrderKind.None,
    ...request
  }: CreateOrderParams & { strategyOrderKind?: StrategyOrderKind },
  predicate: (order: Order) => boolean,
): Promise<Order> => {
  const clientOrderIndex =
    request.clientOrderIndex ??
    (await transactionConfig.generateClientOrderIndex(strategyOrderKind))

  const executed = await createOrder({ ...request, clientOrderIndex }).then(
    () => true,
    (error: unknown) => {
      if (isDefinitiveRejection(error)) {
        throw error
      }
      return false
    },
  )

  return watchOrderByClientIndex(
    {
      accountIndex: request.accountIndex,
      marketId: request.orderBookIndex,
      clientOrderIndex,
    },
    predicate,
    SIGNED_TX_LIFETIME_MS,
  ).catch((error: unknown) => {
    if (executed) {
      throw new UnconfirmedOrderError(`Order ${clientOrderIndex} was placed but never confirmed`, {
        cause: error,
      })
    }
    // Only the venue saying it has no such order rules out one that landed
    // unseen; a failed lookup does not.
    if (!(error instanceof OrderNotFoundError)) {
      throw new UnconfirmedOrderError(`Order ${clientOrderIndex} could not be looked up`, {
        cause: error,
      })
    }
    throw error
  })
}

export const modifyOrderUntilApplied = async (
  request: ModifyOrderParams & { clientOrderIndex: number },
): Promise<Order> => {
  const { accountIndex, marketId, clientOrderIndex, price, triggerPrice, baseAmount } = request

  const market = selectOrderBookMeta(useLighterStore.getState(), { marketId })

  const isApplied = (order: Order) =>
    convertFloatToBase(order.price, market.price_decimals) === price &&
    convertFloatToBase(order.trigger_price, market.price_decimals) === triggerPrice &&
    convertFloatToBase(order.initial_base_amount, market.size_decimals) === baseAmount

  let modifyError: unknown
  await modifyOrder(request).catch((error: unknown) => {
    if (isNonRetryableOrderError(error)) {
      throw error
    }
    modifyError = error
  })
  return watchOrderByClientIndex(
    { accountIndex, marketId, clientOrderIndex },
    (order) => isApplied(order) || !isOrderActive(order),
  ).catch((error: unknown) => {
    throw modifyError ?? error
  })
}

// A rate-limited or dropped cancel leaves the order filling on the book, so it
// is resent until the order is terminal or the window runs out.
const CANCEL_RESEND_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000, 60_000, 60_000]
const CANCEL_CONFIRMATION_TIMEOUT_MS =
  CANCEL_RESEND_DELAYS_MS.reduce((total, delay) => total + delay, 0) + ORDER_CONFIRMATION_TIMEOUT_MS

export const cancelOrderUntilTerminalState = async (
  request: CancelOrderParams & { clientOrderIndex: number },
): Promise<Order> => {
  const { accountIndex, marketId, clientOrderIndex } = request
  let done = false
  let resendTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleResend = (attempt: number) => {
    const delay = CANCEL_RESEND_DELAYS_MS[attempt]
    if (done || delay === undefined) return
    resendTimer = setTimeout(() => {
      void cancelOrder(request)
        .catch(() => {})
        .then(() => scheduleResend(attempt + 1))
    }, delay)
  }

  await cancelOrder(request).catch(() => {})
  scheduleResend(0)
  try {
    return await watchOrderByClientIndex(
      { accountIndex, marketId, clientOrderIndex },
      (order) => !isOrderActive(order),
      CANCEL_CONFIRMATION_TIMEOUT_MS,
    )
  } finally {
    done = true
    clearTimeout(resendTimer)
  }
}
