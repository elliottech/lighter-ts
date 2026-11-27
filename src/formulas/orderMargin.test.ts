import { describe, expect, it } from 'vitest'
import { OrderTriggerStatusEnum } from 'zklighter-perps'

import { USDC_ASSET_ID } from '../store/orderbook/selectors'
import type { AssetBalance } from '../store/types'
import type { AssetMeta, OrderBookDetail } from '../types/compatibility'

import { computeAvailableOrderMargin, computeSpotAvailableToTradeLimit } from './orderMargin'
import { marginFractionToPercentage } from './common'

describe('computeAvailableOrderMargin', () => {
  it('counts triggered stop-limit orders but not untriggered ones', () => {
    const tav = 1_000
    const imr = 200
    const initialMarginFraction = 2_500
    const imf = marginFractionToPercentage(initialMarginFraction)
    const orders = [
      {
        trigger_status: OrderTriggerStatusEnum.Na,
        is_ask: false,
        remaining_base_amount: 1,
        price: 100,
      },
      {
        trigger_status: OrderTriggerStatusEnum.MarkPrice,
        is_ask: false,
        remaining_base_amount: 1,
        price: 100,
      },
    ]

    expect(
      computeAvailableOrderMargin(
        { 0: { default_initial_margin_fraction: initialMarginFraction } },
        { 0: 100 },
        {},
        { 0: orders },
        {},
        tav,
        imr,
        0,
      ),
    ).toBe(tav - imr - 100 * imf)
  })
})

describe('computeSpotAvailableToTradeLimit', () => {
  const usdcBalance: AssetBalance = {
    asset_id: USDC_ASSET_ID,
    margin_mode: 'enabled',
    balance: 0,
    margin_balance: 100,
    locked_balance: 0,
    available_balance: 0,
    available_margin_balance: 100,
  }
  const asset = { asset_id: USDC_ASSET_ID, loan_to_value: '1' } as AssetMeta
  const market = { size_decimals: 4, price_decimals: 2 } as OrderBookDetail

  it.each([
    [870, 70],
    [50, 50],
  ])('bounds unified USDC by reserve and available order margin %s', (margin, expected) => {
    expect(
      computeSpotAvailableToTradeLimit(
        asset,
        { [USDC_ASSET_ID]: usdcBalance },
        market,
        1,
        false,
        margin,
        30,
      ),
    ).toBe(expected)
  })
})
