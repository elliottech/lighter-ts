import { describe, expect, it } from 'vitest'

import { LIT_ASSET_ID, USDC_ASSET_ID } from '../store/orderbook/selectors'
import type { DetailedAccount } from '../store/types'

import { computeOperatorPoolsEquity } from './useAccountsEquity'

type AssetFixture = { asset_id: number; balance: number; margin_balance: number }

const usdcMargin = (marginBalance: number): AssetFixture => ({
  asset_id: USDC_ASSET_ID,
  balance: 0,
  margin_balance: marginBalance,
})

const pool = (
  index: number,
  totalAssetValue: number,
  operatorShares: number,
  totalShares: number,
  assets: AssetFixture[],
) =>
  ({
    index,
    total_asset_value: totalAssetValue,
    assets,
    pool_info: { operator_shares: operatorShares, total_shares: totalShares },
  }) as unknown as DetailedAccount

const INDEX_PRICES = { [USDC_ASSET_ID]: 1, [LIT_ASSET_ID]: 4 }

describe('computeOperatorPoolsEquity', () => {
  // The operator owns every share
  it('values fully operator-owned pools at their perps value', () => {
    const pools = [
      pool(1, 5045.414697, 5000000, 5000000, [usdcMargin(4990.648974)]),
      pool(2, 4545.145427, 5000000, 5000000, [usdcMargin(4690.077095)]),
      pool(3, 5125.847958, 5000000, 5000000, [usdcMargin(5009.209596)]),
      pool(4, 5474.317094, 5000000, 5000000, [usdcMargin(5373.711335)]),
      pool(5, 5668.115222, 5000000, 5000000, [usdcMargin(4948.140939)]),
      pool(6, 4931.238714, 5000000, 5000000, [usdcMargin(4931.238715)]),
    ]

    expect(computeOperatorPoolsEquity(pools, INDEX_PRICES)).toBeCloseTo(30790.079112, 6)
  })

  // Two of the pools have outside depositors
  it('values partially owned pools by the operator share of total shares', () => {
    const pools = [
      pool(7, 863.809546, 1000000, 1000000, [usdcMargin(832.572068)]),
      pool(8, 923.138597, 1000000, 1000000, [usdcMargin(926.220336)]),
      pool(9, 1464.872385, 1013703, 1498507, [usdcMargin(1407.70268)]),
      pool(10, 993.326052, 1004800, 1004800, [usdcMargin(912.865856)]),
      pool(11, 5.511507, 926725, 14368758, [usdcMargin(5.511507)]),
    ]

    expect(computeOperatorPoolsEquity(pools, INDEX_PRICES)).toBeCloseTo(3771.579677, 6)
  })

  it('adds the pool spot holdings at index prices', () => {
    const pools = [
      pool(1, 1000, 50, 100, [
        { asset_id: USDC_ASSET_ID, balance: 200, margin_balance: 300 },
        { asset_id: LIT_ASSET_ID, balance: 100, margin_balance: 0 },
      ]),
    ]

    expect(computeOperatorPoolsEquity(pools, INDEX_PRICES)).toBe(800)
  })

  it('ignores pools without operator shares', () => {
    const pools = [pool(1, 1000, 0, 100, []), pool(2, 400, 100, 100, [])]

    expect(computeOperatorPoolsEquity(pools, INDEX_PRICES)).toBe(400)
  })

  it('is unknown while a held asset has no index price', () => {
    const pools = [
      pool(1, 1000, 100, 100, []),
      pool(2, 1000, 100, 100, [{ asset_id: LIT_ASSET_ID, balance: 10, margin_balance: 0 }]),
    ]

    expect(computeOperatorPoolsEquity(pools, { [USDC_ASSET_ID]: 1 })).toBeNull()
  })

  it('does not need prices for assets with nothing priced', () => {
    const pools = [
      pool(1, 1000, 100, 100, [
        { asset_id: LIT_ASSET_ID, balance: 0, margin_balance: 0 },
        { asset_id: USDC_ASSET_ID, balance: 0, margin_balance: 500 },
      ]),
    ]

    expect(computeOperatorPoolsEquity(pools, {})).toBe(1000)
  })
})
