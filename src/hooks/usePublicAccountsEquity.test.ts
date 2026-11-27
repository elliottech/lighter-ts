import { describe, expect, it } from 'vitest'
import {
  BinaryOptionMarketStatsOutcomeEnum,
  BinaryOptionMarketStatsStatusEnum,
} from 'zklighter-perps'

import { LIT_ASSET_ID, USDC_ASSET_ID } from '../store/orderbook/selectors'
import type { DetailedAccount, PublicPoolMetadata } from '../store/types'

import { type PoolMetadataResult, computePublicAccountEquity } from './usePublicAccountsEquity'

const POOL_INDEX = 1000
const STAKING_POOL_INDEX = 2000

const INDEX_PRICES = { [USDC_ASSET_ID]: 1, [LIT_ASSET_ID]: 4 }

const account = ({
  shares = [],
  pendingUnlocks = [],
  litBalance = 0,
}: {
  shares?: { public_pool_index: number; shares_amount: number }[]
  pendingUnlocks?: { amount: number }[]
  litBalance?: number
}) =>
  ({
    index: 1,
    total_asset_value: 100,
    assets: [
      { asset_id: USDC_ASSET_ID, balance: 50, margin_balance: 0 },
      { asset_id: LIT_ASSET_ID, balance: litBalance, margin_balance: 0 },
    ],
    shares,
    pending_unlocks: pendingUnlocks,
  }) as unknown as DetailedAccount

const STAKING_POOLS = [
  {
    account_index: STAKING_POOL_INDEX,
    total_shares: 100,
    total_spot_value: 400,
    assets: [{ asset_id: LIT_ASSET_ID, balance: 100 }],
  },
] as unknown as PublicPoolMetadata[]

const POOL = {
  account_index: POOL_INDEX,
  total_shares: 100,
  total_asset_value: 300,
  total_spot_value: 100,
} as unknown as PublicPoolMetadata

const pools = (result: PoolMetadataResult) => new Map([[POOL_INDEX, result]])

const POOL_SHARE = { public_pool_index: POOL_INDEX, shares_amount: 50 }
const STAKING_SHARE = { public_pool_index: STAKING_POOL_INDEX, shares_amount: 10 }

describe('computePublicAccountEquity', () => {
  it('sums every leg once everything is loaded', () => {
    const equity = computePublicAccountEquity(
      account({ shares: [POOL_SHARE, STAKING_SHARE], pendingUnlocks: [{ amount: 5 }] }),
      STAKING_POOLS,
      pools({ pool: POOL, isPending: false }),
      INDEX_PRICES,
      {},
    )

    expect(equity).toMatchObject({
      perpsEquity: 100,
      spotEquity: 50,
      poolEquity: 200,
      stakingAmount: 10,
      stakingEquity: 40,
      pendingUnstakedEquity: 20,
      totalEquity: 410,
      isPending: false,
    })
  })

  it('is pending while a held pool is loading', () => {
    const equity = computePublicAccountEquity(
      account({ shares: [POOL_SHARE] }),
      STAKING_POOLS,
      pools({ pool: undefined, isPending: true }),
      INDEX_PRICES,
      {},
    )

    expect(equity).toMatchObject({ poolEquity: null, totalEquity: null, isPending: true })
  })

  it('is unknown but not pending when a held pool failed to load', () => {
    const equity = computePublicAccountEquity(
      account({ shares: [POOL_SHARE] }),
      STAKING_POOLS,
      pools({ pool: undefined, isPending: false }),
      INDEX_PRICES,
      {},
    )

    expect(equity).toMatchObject({
      perpsEquity: 100,
      spotEquity: 50,
      poolEquity: null,
      totalEquity: null,
      isPending: false,
    })
  })

  it('counts a pool that no longer exists as zero', () => {
    const equity = computePublicAccountEquity(
      account({ shares: [POOL_SHARE] }),
      STAKING_POOLS,
      pools({ pool: null, isPending: false }),
      INDEX_PRICES,
      {},
    )

    expect(equity).toMatchObject({ poolEquity: 0, totalEquity: 150, isPending: false })
  })

  it('leaves staking unknown but not pending when the staking pool list failed to load', () => {
    const equity = computePublicAccountEquity(
      account({ shares: [STAKING_SHARE] }),
      undefined,
      new Map(),
      INDEX_PRICES,
      {},
    )

    expect(equity).toMatchObject({
      stakingAmount: null,
      stakingEquity: null,
      totalEquity: null,
      isPending: false,
    })
  })

  it('is pending while a held asset has no index price', () => {
    const equity = computePublicAccountEquity(
      account({ litBalance: 10 }),
      STAKING_POOLS,
      new Map(),
      { [USDC_ASSET_ID]: 1 },
      {},
    )

    expect(equity).toMatchObject({ spotEquity: null, totalEquity: null, isPending: true })
  })

  it('counts an open BO position once: at cost in total_asset_value, at its mark in boEquity', () => {
    // 1000 USDC, then 100 Up bought at 40¢: total_asset_value stays 1000 (the backend adds the 40 cost back in).
    const equity = computePublicAccountEquity(
      {
        ...account({}),
        total_asset_value: 1000,
        assets: [],
        bo_positions: [
          { market_id: 7, sign: 1, size: '100', avg_entry_price: '0.4', entry_quote: '40' },
        ],
      } as unknown as DetailedAccount,
      STAKING_POOLS,
      new Map(),
      INDEX_PRICES,
      {
        7: {
          mid_price: 0.6,
          last_trade_price: 0.6,
          outcome: BinaryOptionMarketStatsOutcomeEnum.None,
          status: BinaryOptionMarketStatsStatusEnum.Active,
        },
      },
    )

    expect(equity).toMatchObject({ perpsEquity: 960, boEquity: 60, totalEquity: 1020 })
  })
})
