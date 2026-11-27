import type { Clock, StrategyEngine } from '../engine/types'
import type { WorkerMarketData } from './WorkerMarketData'
import {
  type WsMessage,
  type WsOrder,
  selectOrderById,
  selectPerpsMarketsStats,
  selectSpotMarketsStats,
  useLighterStore,
  useWsSubStore,
} from '../..'
import { captureWorkerException } from './captureWorkerException'
import { fetchOrderSnapshot } from '../orderSnapshot'
import { getOrCreateAuthToken, resetAuthToken } from '../../transactions'

import type { StrategyWorkerConfig } from './strategyWorkerConfig'

export const WEBSOCKET_JANITOR_INTERVAL_MS = 5_000

const isPongOverdue = (
  { lastPingTime, lastPongTime }: ReturnType<typeof useWsSubStore.getState>,
  pongTimeoutMs: number,
) => !!lastPingTime && !!lastPongTime && lastPingTime - lastPongTime > pongTimeoutMs

const isPriceFeedLive = (state: ReturnType<typeof useWsSubStore.getState>, pongTimeoutMs: number) =>
  state.ws !== null && !isPongOverdue(state, pongTimeoutMs)

export const makeIsWorkerPriceFeedLive =
  ({ wsPongTimeoutMs }: StrategyWorkerConfig) =>
  () =>
    isPriceFeedLive(useWsSubStore.getState(), wsPongTimeoutMs)

/**
 * Worker-owned market-stats websocket. The `init` subscribes to
 * the perps and spot market-stats channels on open; every flush into
 * useLighterStore is copied into WorkerMarketData. The socket stays up only
 * while strategies are running: `websocketJanitor` closes it when idle and
 * clears the cached prices, and `keepAlive` pings it, drops it on a missed pong
 * and reconnects it after an unexpected close (keeping the cached prices, which
 * are not served until the socket is live again).
 * Nothing is sent or received before the worker has authenticated: the socket
 * opens with the account's auth token, and a worker whose authentication
 * failed never connects (it runs no engines).
 */
export class WorkerWebsocket {
  private started = false
  private janitorHandle: number | null = null
  private keepAliveHandle: number | null = null
  /** Bumped by `disconnect()` so a connect still waiting on auth is dropped. */
  private connectGeneration = 0
  private readonly unsubs: Array<() => void> = []

  constructor(
    private readonly marketData: WorkerMarketData,
    private readonly clock: Clock,
    private readonly hasRunningStrategies: () => boolean,
    private readonly authenticated: Promise<number>,
    private readonly onOrder: (order: WsOrder) => void,
    private readonly getEngines: () => Map<string, StrategyEngine>,
    private readonly config: StrategyWorkerConfig,
    /** The socket closed before it opened, which is how a rejected auth token shows. */
    private readonly onOpenFailed: () => void = () => {},
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubs.push(
      useLighterStore.subscribe(selectPerpsMarketsStats, (stats) => {
        for (const market of Object.values(stats)) {
          this.marketData.applyPrice({
            marketId: market.market_id,
            indexPrice: market.index_price ?? null,
            markPrice: market.mark_price ?? null,
            midPrice: market.mid_price ?? null,
            bestAskPrice: market.best_ask_price ?? null,
            bestBidPrice: market.best_bid_price ?? null,
          })
        }
      }),
      useLighterStore.subscribe(selectSpotMarketsStats, (stats) => {
        for (const market of Object.values(stats)) {
          this.marketData.applyPrice({
            marketId: market.market_id,
            indexPrice: market.index_price ?? null,
            markPrice: null,
            midPrice: market.mid_price ?? null,
            bestAskPrice: market.best_ask_price ?? null,
            bestBidPrice: market.best_bid_price ?? null,
          })
        }
      }),
      useWsSubStore.subscribe((state, prev) => {
        const { wsPongTimeoutMs } = this.config
        if (isPriceFeedLive(state, wsPongTimeoutMs) && !isPriceFeedLive(prev, wsPongTimeoutMs)) {
          this.marketData.recheckPrices()
        }
        if (prev.wsLoading && !state.wsLoading && !state.ws) {
          // The next attempt signs a new token instead of resending the rejected one.
          resetAuthToken()
          this.onOpenFailed()
          return
        }
        if (!state.ws || prev.ws) return
        this.authenticated.then(
          (accountIndex) =>
            useWsSubStore
              .getState()
              .actions.switchAccount(
                accountIndex,
                true,
                () => Promise.resolve(),
                getOrCreateAuthToken,
              ),
          () => {},
        )
      }),
    )
    this.scheduleJanitor()
  }

  stop(): void {
    this.started = false
    if (this.janitorHandle !== null) this.clock.clearTimeout(this.janitorHandle)
    this.janitorHandle = null
    for (const unsub of this.unsubs) unsub()
    this.unsubs.length = 0
    this.disconnect()
  }

  /** No-op while the socket is open or opening. */
  connect(): void {
    const url = this.config.wsApiBase
    if (!url) return
    this.scheduleKeepAlive()
    const generation = this.connectGeneration
    this.authenticated.then(
      (accountIndex) => {
        if (generation === this.connectGeneration) this.open(url, accountIndex)
      },
      () => {},
    )
  }

  private open(url: string, accountIndex: number): void {
    useWsSubStore
      .getState()
      .actions.init(
        url,
        () => {},
        () => getOrCreateAuthToken(accountIndex),
        this.config.encoding,
        this.config.customServer,
        async (message: WsMessage) => {
          if (message.type === 'subscribed/account_all_orders') {
            for (const marketId in message.orders) {
              message.orders[marketId]?.forEach(this.onOrder)
            }
            const engines = this.getEngines()
            const lighterStoreState = useLighterStore.getState()
            for (const [engineId, engine] of engines.entries()) {
              const workingOrders = engine?.getWorkingOrders()
              for (const orderId in workingOrders) {
                const outdatedOrder = workingOrders[orderId]
                if (!outdatedOrder) continue
                const storeOrder = selectOrderById(lighterStoreState, {
                  accountIndex,
                  marketId: outdatedOrder.market_index,
                  orderId,
                })
                if (storeOrder) continue
                // Not in the snapshot: the order left the book during the
                // disconnect, so its final state comes from REST.
                try {
                  const restApiOrder = await fetchOrderSnapshot({
                    accountIndex,
                    clientOrderIndex: outdatedOrder.client_order_index,
                  })
                  if (!restApiOrder) throw new Error('order not found')
                  engines.get(engineId)?.onFillUpdate({ restingOrder: restApiOrder })
                } catch (error) {
                  captureWorkerException(
                    new Error(
                      `Strategy ${engineId} could not reconcile its working order ${orderId}`,
                      { cause: error },
                    ),
                    {
                      id: engineId,
                      orderId,
                      tags: {
                        feature: 'strategy-worker-order-reconciliation',
                      },
                    },
                  )
                }
              }
            }
          } else if (message.type === 'update/account_all_orders') {
            for (const marketId in message.orders) {
              message.orders[marketId]?.forEach(this.onOrder)
            }
          }
        },
      )
      .catch((error: unknown) => {
        useWsSubStore.setState({ wsLoading: false })
        captureWorkerException(error, {
          tags: { feature: 'strategy-worker-websocket' },
        })
      })
  }

  private disconnect(): void {
    this.connectGeneration++
    if (this.keepAliveHandle !== null) {
      this.clock.clearTimeout(this.keepAliveHandle)
      this.keepAliveHandle = null
    }
    useWsSubStore.getState().actions.forceClose()
  }

  private scheduleJanitor(): void {
    this.janitorHandle = this.clock.setTimeout(() => {
      this.websocketJanitor()
      if (this.started) this.scheduleJanitor()
    }, WEBSOCKET_JANITOR_INTERVAL_MS)
  }

  private websocketJanitor(): void {
    if (this.hasRunningStrategies()) return
    this.disconnect()
    // Unexpected drops keep the cache, but after an idle close the next
    // strategy must wait for a fresh price instead of a stale one.
    this.marketData.clearPrices()
  }

  private scheduleKeepAlive(): void {
    if (this.keepAliveHandle !== null) return
    this.keepAliveHandle = this.clock.setTimeout(() => {
      this.keepAliveHandle = null
      this.keepAlive()
    }, this.config.wsPingIntervalMs)
  }

  private keepAlive(): void {
    if (!this.hasRunningStrategies()) return
    const state = useWsSubStore.getState()
    const { ws, actions } = state
    if (!ws) {
      // Unexpected close (or still opening): init is a no-op while opening.
      this.connect()
      return
    }
    if (isPongOverdue(state, this.config.wsPongTimeoutMs)) {
      actions.forceClose()
    } else {
      actions.ping()
    }
    this.scheduleKeepAlive()
  }
}
