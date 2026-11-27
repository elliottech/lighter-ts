import type { IcebergConfig, LimitChaseConfig, MarketDataSource } from '../engine/types'
import { describe, expect, it } from 'vitest'
import { assertStrategyNotional, estimateStrategyNotional } from './strategyNotional'

const marketData = (prices: {
  bid?: number | null
  ask?: number | null
  mid?: number | null
  mark?: number | null
}): MarketDataSource => ({
  getMarket: () => undefined,
  getIndexPrice: () => null,
  getMarkPrice: () => prices.mark ?? null,
  getMidPrice: () => prices.mid ?? null,
  getBestBidPrice: () => prices.bid ?? null,
  getBestAskPrice: () => prices.ask ?? null,
})

const chase = (isAsk: 0 | 1, totalSize: number): LimitChaseConfig => ({
  accountIndex: 5,
  marketId: 1,
  isAsk,
  totalSize,
  reduceOnly: false,
  maxDistancePercent: 0,
  restingChunkBaseAmount: 1,
  repriceIntervalMs: 1000,
})

const iceberg: IcebergConfig = {
  accountIndex: 5,
  marketId: 1,
  isAsk: 0,
  totalSize: 2,
  reduceOnly: false,
  postOnly: true,
  restingChunkBaseAmount: 1,
  repriceIntervalMs: 1000,
  limitPrice: 150,
  maxRestingOrders: 1,
}

describe('estimateStrategyNotional', () => {
  const book = marketData({ bid: 99, ask: 101, mid: 100, mark: 100 })

  it('prices a buy at the best ask and a sell at the best bid', () => {
    expect(estimateStrategyNotional('chase-limit', chase(0, 10), book)).toBe(1010)
    expect(estimateStrategyNotional('chase-limit', chase(1, 10), book)).toBe(990)
  })

  it('falls back to the mid, then the mark, without the side of the book', () => {
    expect(
      estimateStrategyNotional('chase-limit', chase(0, 10), marketData({ bid: 99, mid: 100 })),
    ).toBe(1000)
    expect(
      estimateStrategyNotional('chase-limit', chase(1, 10), marketData({ ask: 101, mark: 102 })),
    ).toBe(1020)
    expect(estimateStrategyNotional('chase-limit', chase(1, 10), marketData({}))).toBeNull()
  })

  it('skips a zero price from an empty book side or a missing mid', () => {
    const emptyAsk = marketData({ bid: 99, ask: 0, mid: 0, mark: 100 })
    expect(estimateStrategyNotional('chase-limit', chase(0, 20_000), emptyAsk)).toBe(2_000_000)
    expect(() =>
      assertStrategyNotional('chase-limit', chase(0, 20_000), emptyAsk, 1_000_000),
    ).toThrow('Strategy notional of about 2000000 exceeds the maximum of 1000000')
    const noPrice = marketData({ bid: 0, ask: 0, mid: 0, mark: 0 })
    expect(estimateStrategyNotional('chase-limit', chase(1, 10), noPrice)).toBeNull()
  })

  it('prices an iceberg buy at its limit price', () => {
    expect(estimateStrategyNotional('iceberg', iceberg, book)).toBe(300)
  })

  it('prices an iceberg sell at the higher of its limit and the bid', () => {
    const sell = (totalSize: number, limitPrice: number): IcebergConfig => ({
      ...iceberg,
      isAsk: 1,
      postOnly: false,
      totalSize,
      limitPrice,
    })
    const deep = marketData({ bid: 2_999, ask: 3_001, mid: 3_000, mark: 3_000 })
    expect(estimateStrategyNotional('iceberg', sell(900_000, 1), deep)).toBe(2_699_100_000)
    expect(() => assertStrategyNotional('iceberg', sell(900_000, 1), deep, 1_000_000)).toThrow(
      'Strategy notional of about 2699100000 exceeds the maximum of 1000000',
    )
    expect(estimateStrategyNotional('iceberg', sell(2, 3_100), deep)).toBe(6_200)
    expect(estimateStrategyNotional('iceberg', sell(2, 1), marketData({}))).toBeNull()
  })
})

describe('assertStrategyNotional', () => {
  const book = marketData({ bid: 99, ask: 101 })

  it('allows a strategy up to the maximum', () => {
    expect(() => assertStrategyNotional('chase-limit', chase(1, 10), book, 990)).not.toThrow()
  })

  it('rejects a strategy above the maximum', () => {
    expect(() => assertStrategyNotional('chase-limit', chase(0, 10), book, 1000)).toThrow(
      'Strategy notional of about 1010 exceeds the maximum of 1000',
    )
  })

  it('rejects a strategy without a price', () => {
    expect(() => assertStrategyNotional('chase-limit', chase(0, 10), marketData({}), 1000)).toThrow(
      'No price to estimate the notional of market 1',
    )
  })

  it('ignores a limitPrice on a strategy other than an iceberg', () => {
    const withLimit = { ...chase(0, 10), limitPrice: 0 } as LimitChaseConfig
    expect(estimateStrategyNotional('chase-limit', withLimit, book)).toBe(1010)
    expect(() => assertStrategyNotional('chase-limit', withLimit, book, 1000)).toThrow(
      'Strategy notional of about 1010 exceeds the maximum of 1000',
    )
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10', undefined])(
    'rejects a totalSize of %s',
    (totalSize) => {
      const sized = { ...chase(0, 10), totalSize } as unknown as LimitChaseConfig
      expect(() => assertStrategyNotional('chase-limit', sized, book, 1e12)).toThrow(
        'Strategy totalSize must be a positive number',
      )
    },
  )

  it.each([2, '1', true, undefined])('rejects an isAsk of %s', (isAsk) => {
    const sided = { ...chase(0, 10), isAsk } as unknown as LimitChaseConfig
    expect(() => assertStrategyNotional('chase-limit', sided, book, 1e12)).toThrow(
      'Strategy isAsk must be 0 or 1',
    )
  })

  it.each([0, -150, Number.NaN, '150', undefined])(
    'rejects an iceberg with a limitPrice of %s',
    (limitPrice) => {
      const priced = { ...iceberg, limitPrice } as unknown as IcebergConfig
      expect(() => assertStrategyNotional('iceberg', priced, book, 1e12)).toThrow(
        'Iceberg limitPrice must be a positive number',
      )
    },
  )

  it('rejects an iceberg whose notional at its limit price is above the maximum', () => {
    expect(() => assertStrategyNotional('iceberg', iceberg, book, 299)).toThrow(
      'Strategy notional of about 300 exceeds the maximum of 299',
    )
    expect(() => assertStrategyNotional('iceberg', iceberg, book, 300)).not.toThrow()
  })
})
