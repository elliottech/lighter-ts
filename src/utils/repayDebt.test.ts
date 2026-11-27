import { beforeEach, describe, expect, it } from 'vitest'

import { USDC_ASSET_ID } from '../store/orderbook/selectors'
import { type LighterStore, useLighterStore } from '../store/useLighterStore'
import { TxOrderTypes, TxTimeInForceTypes } from '../types/user'

import { buildRepayDebtOrders } from './repayDebt'

const ACCOUNT_INDEX = 7
const ETH = { assetId: 10, marketId: 2048 }
const BTC = { assetId: 11, marketId: 2049 }

const spotMeta = ({ assetId, marketId }: typeof ETH) => ({
  market_id: marketId,
  market_type: 'spot',
  symbol: `A${assetId}/USDC`,
  backend_symbol: `A${assetId}/USDC`,
  base_asset_id: assetId,
  quote_asset_id: USDC_ASSET_ID,
  price_decimals: 2,
  size_decimals: 4,
})

const balance = (assetId: number, margin_balance: number, margin_mode = 'enabled') => ({
  asset_id: assetId,
  margin_mode,
  balance: margin_balance,
  margin_balance,
  locked_balance: 0,
  available_balance: margin_balance,
  available_margin_balance: margin_balance,
})

type Stats = { best_bid_price?: number; index_price?: number }

const setUp = (balances: ReturnType<typeof balance>[], stats: Record<number, Stats>) =>
  useLighterStore.setState({
    accountIndex: ACCOUNT_INDEX,
    spotOrderBookMetas: { [ETH.marketId]: spotMeta(ETH), [BTC.marketId]: spotMeta(BTC) },
    spotMarketsStats: Object.fromEntries(
      Object.entries(stats).map(([marketId, s]) => [
        marketId,
        { market_id: Number(marketId), mid_price: 0, ...s },
      ]),
    ),
    accounts: {
      [ACCOUNT_INDEX]: {
        assetBalances: Object.fromEntries(balances.map((b) => [b.asset_id, b])),
      },
    },
  } as unknown as Partial<LighterStore>)

const build = (debt: number, isMarketDataLive = true) =>
  buildRepayDebtOrders(useLighterStore.getState(), {
    accountIndex: ACCOUNT_INDEX,
    debt,
    isMarketDataLive,
  })

describe('buildRepayDebtOrders', () => {
  beforeEach(() => setUp([], {}))

  it('sells at 1% under the best bid when the book is near the index', () => {
    setUp([balance(ETH.assetId, 10)], { [ETH.marketId]: { best_bid_price: 100, index_price: 100 } })

    const { orders, skippedMarketIds } = build(495)

    expect(skippedMarketIds).toEqual([])
    expect(orders).toEqual([
      {
        type: 'create',
        params: {
          accountIndex: ACCOUNT_INDEX,
          orderBookIndex: ETH.marketId,
          baseAmount: 50000,
          price: 9900,
          isAsk: 1,
          reduceOnly: 0,
          orderType: TxOrderTypes.OrderTypeMarket,
          timeInForce: TxTimeInForceTypes.OrderImmediateOrCancel,
          orderExpiry: 0,
          triggerPrice: 0,
        },
      },
    ])
  })

  it('floors the price at 10% under the index when the bid is far below it', () => {
    setUp([balance(ETH.assetId, 10)], { [ETH.marketId]: { best_bid_price: 55, index_price: 100 } })

    const [order] = build(90).orders

    expect(order?.params.price).toBe(9000)
    expect(order?.params.baseAmount).toBe(10000)
  })

  it.each([
    ['index', { best_bid_price: 100 }],
    ['index of 0', { best_bid_price: 100, index_price: 0 }],
    ['best bid', { index_price: 100 }],
    ['best bid of 0', { best_bid_price: 0, index_price: 100 }],
  ])('skips a market without a %s', (_missing, stats) => {
    setUp([balance(ETH.assetId, 10)], { [ETH.marketId]: stats })

    expect(build(100)).toEqual({ orders: [], skippedMarketIds: [ETH.marketId] })
  })

  it('skips a market without stats', () => {
    setUp([balance(ETH.assetId, 10)], {})

    expect(build(100)).toEqual({ orders: [], skippedMarketIds: [ETH.marketId] })
  })

  it('moves on to the next asset with the debt the first one could not cover', () => {
    setUp([balance(ETH.assetId, 1), balance(BTC.assetId, 10)], {
      [ETH.marketId]: { best_bid_price: 100, index_price: 100 },
      [BTC.marketId]: { best_bid_price: 50, index_price: 50 },
    })

    const { orders } = build(198)

    expect(
      orders.map(({ params }) => [params.orderBookIndex, params.baseAmount, params.price]),
    ).toEqual([
      [ETH.marketId, 10000, 9900],
      [BTC.marketId, 20000, 4950],
    ])
  })

  it('stops once an asset covers the remaining debt', () => {
    setUp([balance(ETH.assetId, 10), balance(BTC.assetId, 10)], {
      [ETH.marketId]: { best_bid_price: 100, index_price: 100 },
      [BTC.marketId]: { best_bid_price: 50, index_price: 50 },
    })

    expect(build(99).orders.map(({ params }) => params.orderBookIndex)).toEqual([ETH.marketId])
  })

  it('ignores USDC, disabled and empty margin balances', () => {
    setUp(
      [balance(USDC_ASSET_ID, -100), balance(ETH.assetId, 10, 'disabled'), balance(BTC.assetId, 0)],
      {
        [ETH.marketId]: { best_bid_price: 100, index_price: 100 },
        [BTC.marketId]: { best_bid_price: 50, index_price: 50 },
      },
    )

    expect(build(100)).toEqual({ orders: [], skippedMarketIds: [] })
  })

  it('never sells more than a negative or sub-tick balance holds', () => {
    setUp([balance(ETH.assetId, -1), balance(BTC.assetId, 0.00001)], {
      [ETH.marketId]: { best_bid_price: 100, index_price: 100 },
      [BTC.marketId]: { best_bid_price: 50, index_price: 50 },
    })

    expect(build(100)).toEqual({ orders: [], skippedMarketIds: [] })
  })

  it('sends integer sizes and prices of at least 1', () => {
    setUp([balance(ETH.assetId, 10)], {
      [ETH.marketId]: { best_bid_price: 123.456789, index_price: 123.4 },
    })

    for (const debt of [0.0000001, 33.333333, 1234.5678]) {
      for (const { params } of build(debt).orders) {
        expect(Number.isInteger(params.baseAmount) && params.baseAmount >= 1).toBe(true)
        expect(Number.isInteger(params.price) && params.price >= 1).toBe(true)
      }
    }
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'builds nothing for a debt of %s',
    (debt) => {
      setUp([balance(ETH.assetId, 10)], {
        [ETH.marketId]: { best_bid_price: 100, index_price: 100 },
      })

      expect(build(debt)).toEqual({ orders: [], skippedMarketIds: [] })
    },
  )

  it('skips every market while market data is not live', () => {
    setUp([balance(ETH.assetId, 1), balance(BTC.assetId, 10)], {
      [ETH.marketId]: { best_bid_price: 100, index_price: 100 },
      [BTC.marketId]: { best_bid_price: 50, index_price: 50 },
    })

    expect(build(198, false)).toEqual({
      orders: [],
      skippedMarketIds: [ETH.marketId, BTC.marketId],
    })
  })
})
