import { type Clock, type MarketDataSource, type MarketMeta } from '../engine/types'
import {
  PERPS_OB_FIELDS,
  type PerpsOrderBookDetail,
  SPOT_OB_FIELDS,
  type SpotOrderBookDetail,
  apis,
  getDisplayDecimals,
  useLighterStore,
} from '../..'
import { type PriceSnapshot } from './protocol'
import { keyBy, pick } from 'lodash-es'

export const MARKET_METAS_RETRY_DELAYS_MS = [0, 2_000, 4_000, 8_000, 16_000]

// An empty book side arrives as "", which the market stats parse to 0.
const positivePrice = (price: number | null): number | null =>
  price !== null && Number.isFinite(price) && price > 0 ? price : null

export class WorkerMarketData implements MarketDataSource {
  private readonly markets = new Map<number, MarketMeta>()
  private readonly prices = new Map<number, PriceSnapshot>()
  private readonly priceListeners = new Map<number, Set<() => void>>()
  private marketMetasRequest: Promise<void> | null = null

  constructor(
    private readonly clock: Clock,
    private readonly isPriceFeedLive: () => boolean = () => true,
  ) {}

  initializeMarketMetas(): Promise<void> {
    this.marketMetasRequest ??= this.fetchMarketMetas().finally(() => {
      this.marketMetasRequest = null
    })
    return this.marketMetasRequest
  }

  private async fetchMarketMetas(): Promise<void> {
    let lastError: unknown
    for (const delayMs of MARKET_METAS_RETRY_DELAYS_MS) {
      if (delayMs > 0) await this.sleep(delayMs)
      try {
        await this.loadMarketMetas()
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(resolve, ms)
    })
  }

  // The store's metas are what `useInitOrderBookMetas` sets on the main
  // thread; the worker has no React, so they are set here for the store code
  // that reads them (order lifecycle, trade volumes).
  private async loadMarketMetas(): Promise<void> {
    const { spot_order_book_details, order_book_details } = await apis.orderApi.orderBookDetails()
    const spotMetas = spot_order_book_details.map(
      (detail) =>
        pick({ ...detail, ...getDisplayDecimals(detail) }, SPOT_OB_FIELDS) as SpotOrderBookDetail,
    )
    const perpsMetas = order_book_details.map(
      (detail) =>
        pick({ ...detail, ...getDisplayDecimals(detail) }, PERPS_OB_FIELDS) as PerpsOrderBookDetail,
    )
    for (const meta of spotMetas) this.setMarket(meta)
    for (const meta of perpsMetas) this.setMarket(meta)
    useLighterStore.setState({
      spotOrderBookMetas: keyBy(spotMetas, 'market_id'),
      perpsOrderBookMetas: keyBy(perpsMetas, 'market_id'),
      orderBookMetasLoaded: true,
      // No strategy reads asset balances, so the worker loads no asset metas.
      assetMetasLoaded: true,
    })
  }

  setMarket(market: MarketMeta): void {
    this.markets.set(market.market_id, market)
  }

  hasMarket(marketId: number): boolean {
    return this.markets.has(marketId)
  }

  applyPrice(snapshot: PriceSnapshot): void {
    this.prices.set(snapshot.marketId, {
      marketId: snapshot.marketId,
      indexPrice: positivePrice(snapshot.indexPrice),
      markPrice: positivePrice(snapshot.markPrice),
      midPrice: positivePrice(snapshot.midPrice),
      bestAskPrice: positivePrice(snapshot.bestAskPrice),
      bestBidPrice: positivePrice(snapshot.bestBidPrice),
    })
    const listeners = this.priceListeners.get(snapshot.marketId)
    if (listeners) for (const listener of listeners) listener()
  }

  recheckPrices(): void {
    for (const listeners of this.priceListeners.values()) {
      for (const listener of listeners) listener()
    }
  }

  clearPrices(): void {
    this.prices.clear()
  }

  private livePrice(marketId: number): PriceSnapshot | undefined {
    return this.isPriceFeedLive() ? this.prices.get(marketId) : undefined
  }

  hasPrice(marketId: number): boolean {
    const price = this.livePrice(marketId)
    return (price?.markPrice ?? price?.midPrice ?? null) !== null
  }

  waitForPrice(marketId: number, signal: AbortSignal): Promise<void> {
    if (this.hasPrice(marketId)) return Promise.resolve()
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        listeners.delete(listener)
        if (listeners.size === 0) this.priceListeners.delete(marketId)
        signal.removeEventListener('abort', onAbort)
      }
      const listener = () => {
        if (!this.hasPrice(marketId)) return
        cleanup()
        resolve()
      }
      const onAbort = () => {
        cleanup()
        reject(signal.reason)
      }
      const listeners = this.priceListeners.get(marketId) ?? new Set()
      listeners.add(listener)
      this.priceListeners.set(marketId, listeners)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  getMarket(marketId: number): MarketMeta | undefined {
    return this.markets.get(marketId)
  }

  getIndexPrice(marketId: number): number | null {
    return this.livePrice(marketId)?.indexPrice ?? null
  }

  getMarkPrice(marketId: number): number | null {
    return this.livePrice(marketId)?.markPrice ?? null
  }

  getMidPrice(marketId: number): number | null {
    return this.livePrice(marketId)?.midPrice ?? null
  }

  getBestBidPrice(marketId: number): number | null {
    return this.livePrice(marketId)?.bestBidPrice ?? null
  }

  getBestAskPrice(marketId: number): number | null {
    return this.livePrice(marketId)?.bestAskPrice ?? null
  }
}
