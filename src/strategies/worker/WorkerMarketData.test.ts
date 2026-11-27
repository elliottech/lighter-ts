import type { MarketMeta } from '../engine/types'
import type { PriceSnapshot } from './protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeClock } from '../engine/testUtils'
import { MARKET_METAS_RETRY_DELAYS_MS, WorkerMarketData } from './WorkerMarketData'

const orderBookDetails = vi.hoisted(() => vi.fn())

vi.mock('../..', async (original) => ({
  ...(await original<typeof import('../..')>()),
  apis: { orderApi: { orderBookDetails } },
}))

const market = (market_id: number): MarketMeta => ({
  market_id,
  size_decimals: 5,
  price_decimals: 2,
  min_base_amount: '0',
  min_quote_amount: '0',
  multiplier: '1',
  display_price_decimals: 2,
})

const snapshot = (marketId: number, overrides: Partial<PriceSnapshot> = {}): PriceSnapshot => ({
  marketId,
  indexPrice: null,
  markPrice: 100,
  midPrice: 100,
  bestAskPrice: null,
  bestBidPrice: null,
  ...overrides,
})

describe('WorkerMarketData', () => {
  it('returns undefined / null for unknown markets', () => {
    const md = new WorkerMarketData(new FakeClock())
    expect(md.getMarket(1)).toBeUndefined()
    expect(md.getMarkPrice(1)).toBeNull()
    expect(md.getMidPrice(1)).toBeNull()
  })

  it('stores and reads market metadata by market_id', () => {
    const md = new WorkerMarketData(new FakeClock())
    md.setMarket(market(7))
    expect(md.getMarket(7)?.market_id).toBe(7)
    expect(md.getMarket(8)).toBeUndefined()
  })

  it('reads mark / mid price per market', () => {
    const md = new WorkerMarketData(new FakeClock())
    md.applyPrice(snapshot(1, { markPrice: 50_000, midPrice: 49_999 }))
    expect(md.getMarkPrice(1)).toBe(50_000)
    expect(md.getMidPrice(1)).toBe(49_999)
  })

  it('reads the index price per market, null when absent', () => {
    const md = new WorkerMarketData(new FakeClock())
    expect(md.getIndexPrice(1)).toBeNull()
    md.applyPrice(snapshot(1, { indexPrice: 50_000 }))
    expect(md.getIndexPrice(1)).toBe(50_000)
  })

  it('reads best bid / ask per market, null when absent', () => {
    const md = new WorkerMarketData(new FakeClock())
    expect(md.getBestBidPrice(1)).toBeNull()
    expect(md.getBestAskPrice(1)).toBeNull()
    md.applyPrice(snapshot(1, { bestBidPrice: 49_990, bestAskPrice: 50_010 }))
    expect(md.getBestBidPrice(1)).toBe(49_990)
    expect(md.getBestAskPrice(1)).toBe(50_010)
    md.applyPrice(snapshot(1, { bestBidPrice: null, bestAskPrice: null }))
    expect(md.getBestBidPrice(1)).toBeNull()
    expect(md.getBestAskPrice(1)).toBeNull()
  })

  it('treats a zero or non-finite price, as an empty book side sends, as missing', () => {
    const md = new WorkerMarketData(new FakeClock())
    md.applyPrice(
      snapshot(1, {
        indexPrice: 0,
        markPrice: 0,
        midPrice: 0,
        bestAskPrice: 0,
        bestBidPrice: Number.NaN,
      }),
    )
    expect(md.getIndexPrice(1)).toBeNull()
    expect(md.getMarkPrice(1)).toBeNull()
    expect(md.getMidPrice(1)).toBeNull()
    expect(md.getBestAskPrice(1)).toBeNull()
    expect(md.getBestBidPrice(1)).toBeNull()
    expect(md.hasPrice(1)).toBe(false)
  })

  it('reports whether a market is loaded', () => {
    const md = new WorkerMarketData(new FakeClock())
    expect(md.hasMarket(7)).toBe(false)
    md.setMarket(market(7))
    expect(md.hasMarket(7)).toBe(true)
  })

  it('treats a snapshot without mark or mid price as missing', () => {
    const md = new WorkerMarketData(new FakeClock())
    expect(md.hasPrice(1)).toBe(false)
    md.applyPrice(snapshot(1, { markPrice: null, midPrice: null }))
    expect(md.hasPrice(1)).toBe(false)
    md.applyPrice(snapshot(1, { markPrice: null, midPrice: 10 }))
    expect(md.hasPrice(1)).toBe(true)
  })

  it('waits until a price for the market arrives', async () => {
    const md = new WorkerMarketData(new FakeClock())
    let resolved = false
    const wait = md.waitForPrice(1, new AbortController().signal).then(() => (resolved = true))
    md.applyPrice(snapshot(2))
    await Promise.resolve()
    expect(resolved).toBe(false)
    md.applyPrice(snapshot(1))
    await wait
    expect(resolved).toBe(true)
  })

  it('keeps other waiters on the same market when one aborts', async () => {
    const md = new WorkerMarketData(new FakeClock())
    const aborted = new AbortController()
    const first = md.waitForPrice(1, aborted.signal)
    const second = md.waitForPrice(1, new AbortController().signal)
    aborted.abort(new Error('stopped'))
    await expect(first).rejects.toThrow('stopped')
    md.applyPrice(snapshot(1))
    await expect(second).resolves.toBeUndefined()
  })

  it('rejects the price wait when aborted', async () => {
    const md = new WorkerMarketData(new FakeClock())
    const controller = new AbortController()
    const wait = md.waitForPrice(1, controller.signal)
    controller.abort(new Error('stopped'))
    await expect(wait).rejects.toThrow('stopped')
  })
})

describe('WorkerMarketData.initializeMarketMetas', () => {
  afterEach(() => {
    orderBookDetails.mockReset()
  })

  const details = {
    order_book_details: [market(3)],
    spot_order_book_details: [],
  }

  const fireRetries = async (clock: FakeClock) => {
    for (const delayMs of MARKET_METAS_RETRY_DELAYS_MS.slice(1)) {
      await vi.waitFor(() => expect(clock.pendingCount()).toBe(1))
      expect(clock.nextDueAt()! - clock.now()).toBe(delayMs)
      clock.fireNext()
    }
  }

  it('retries failed fetches on the clock after 0s, 2s, 4s, 8s and 16s', async () => {
    orderBookDetails
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(details)
    const clock = new FakeClock()
    const md = new WorkerMarketData(clock)
    const loaded = md.initializeMarketMetas()

    expect(orderBookDetails).toHaveBeenCalledTimes(1)
    await fireRetries(clock)
    await loaded

    expect(orderBookDetails).toHaveBeenCalledTimes(5)
    expect(md.hasMarket(3)).toBe(true)
  })

  it('rejects with the last error after every attempt fails', async () => {
    orderBookDetails.mockRejectedValue(new Error('503'))
    const clock = new FakeClock()
    const md = new WorkerMarketData(clock)
    const settled = expect(md.initializeMarketMetas()).rejects.toThrow('503')

    await fireRetries(clock)
    await settled

    expect(orderBookDetails).toHaveBeenCalledTimes(MARKET_METAS_RETRY_DELAYS_MS.length)
    expect(clock.pendingCount()).toBe(0)
  })

  it('shares one in-flight load between concurrent callers', async () => {
    orderBookDetails.mockResolvedValue(details)
    const md = new WorkerMarketData(new FakeClock())
    await Promise.all([md.initializeMarketMetas(), md.initializeMarketMetas()])
    expect(orderBookDetails).toHaveBeenCalledTimes(1)
  })
})
