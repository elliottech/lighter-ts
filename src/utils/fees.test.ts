import { afterEach, describe, expect, it } from 'vitest'

import type { BackendFeeTiers } from '../types/user-tiers'

import { type Env, currentEnv } from '../lib/env'
import { defaultLighterFeeTiers, defaultRobinhoodFeeTiers } from '../fallbacks/defaults'
import { selectFeeTierConfigs } from '../store/orderbook/selectors'
import type { OrderBookSlice } from '../store/orderbook/createOrderBookSlice'
import { getPlanFees, resolveFeeTiers, toFeeTierConfigs } from './fees'

const original = currentEnv.env

afterEach(() => {
  currentEnv.env = original
})

describe('toFeeTierConfigs', () => {
  it.each<Env>(['mainnet', 'robinhood-mainnet'])(
    'builds every plan from the %s fallback',
    (env) => {
      currentEnv.env = env
      const configs = toFeeTierConfigs(resolveFeeTiers(null))

      expect(configs.standard.key).toBe('standard')
      expect(configs.plus.key).toBe('plus')
      expect(configs.premium[0]?.key).toBe('premium')
    },
  )

  it('reads fees and thresholds from the backend tiers', () => {
    currentEnv.env = 'mainnet'
    const configs = toFeeTierConfigs(resolveFeeTiers(null))

    expect(configs.premium[1]).toMatchObject({
      key: 'premium_1',
      stakedLit: 1000,
      maker: 0.000039,
      taker: 0.000273,
      discountPercent: '2.5%',
      rateLimit: 5000,
    })
    expect(configs.premium[7]?.discountPercent).toBe('30%')
  })

  it('derives the Robinhood discounts from the maker fee', () => {
    currentEnv.env = 'robinhood-mainnet'
    const configs = toFeeTierConfigs(resolveFeeTiers(null))

    expect(configs.premium.map(({ discountPercent }) => discountPercent)).toEqual([
      '-',
      '2.5%',
      '5%',
      '10%',
      '15%',
      '20%',
      '30%',
    ])
    expect(configs.premium[6]?.minVolume).toBe(500_000_000)
  })

  it('falls back to the bundled tiers when a plan is missing', () => {
    currentEnv.env = 'mainnet'
    const partial: BackendFeeTiers = { user_tiers: [], bo_tiers: [], staking_tiers: [] }

    expect(toFeeTierConfigs(partial)).toEqual(toFeeTierConfigs(resolveFeeTiers(null)))
  })

  it("falls back to the store's env tiers, not the Lighter defaults, when a plan is missing", () => {
    const partial: BackendFeeTiers = { user_tiers: [], bo_tiers: [], staking_tiers: [] }
    const configs = selectFeeTierConfigs({
      feeTiers: partial,
      fallbackFeeTiers: defaultRobinhoodFeeTiers,
    } as unknown as OrderBookSlice)

    expect(configs).toEqual(toFeeTierConfigs(defaultRobinhoodFeeTiers))
    expect(configs).not.toEqual(toFeeTierConfigs(defaultLighterFeeTiers))
  })
})

describe('backend tier limits', () => {
  const withLimits = (
    feeTiers: BackendFeeTiers,
    limits: Record<string, { twap: number; latency: number; rate: number }>,
  ): BackendFeeTiers => ({
    ...feeTiers,
    user_tiers: feeTiers.user_tiers.map((tier) => {
      const tierLimits = limits[tier.name]
      return tierLimits
        ? {
            ...tier,
            twap_fee_ticks: tierLimits.twap,
            taker_latency_ms: tierLimits.latency,
            send_tx_rate_limit: tierLimits.rate,
          }
        : tier
    }),
  })

  it('reads rate limit, TWAP fee and latency from the backend', () => {
    currentEnv.env = 'mainnet'
    const configs = toFeeTierConfigs(
      withLimits(resolveFeeTiers(null), {
        standard: { twap: 200, latency: 250, rate: 60 },
        premium: { twap: 0, latency: 120, rate: 4500 },
      }),
    )

    expect(configs.standard).toMatchObject({ twap: 0.0002, takerLatency: '250ms', rateLimit: 60 })
    expect(configs.premium[0]).toMatchObject({ twap: 0, takerLatency: '120ms', rateLimit: 4500 })
    expect(configs.premium[1]).toMatchObject({ takerLatency: '140ms', rateLimit: 5000 })
  })

  it('reads max sub-accounts from the backend and keeps the bundled limit otherwise', () => {
    currentEnv.env = 'mainnet'
    const fallback = toFeeTierConfigs(resolveFeeTiers(null))
    const feeTiers = resolveFeeTiers(null)
    const configs = toFeeTierConfigs({
      ...feeTiers,
      user_tiers: feeTiers.user_tiers.map((tier) =>
        tier.name === 'plus' ? { ...tier, max_sub_accounts: 20 } : tier,
      ),
    })

    expect(fallback.standard.maxSubAccounts).toBe(4)
    expect(fallback.premium[0]?.maxSubAccounts).toBe(64)
    expect(configs.plus.maxSubAccounts).toBe(20)
    expect(configs.standard.maxSubAccounts).toBe(4)
  })

  it('keeps the bundled limit when the backend sends no rate limit', () => {
    currentEnv.env = 'mainnet'
    const configs = toFeeTierConfigs(
      withLimits(resolveFeeTiers(null), { standard: { twap: 100, latency: 300, rate: 0 } }),
    )

    expect(configs.standard.rateLimit).toBe(40)
  })

  it('derives the latency improvement from the base premium latency', () => {
    currentEnv.env = 'robinhood-mainnet'
    const configs = toFeeTierConfigs(
      withLimits(resolveFeeTiers(null), {
        standard: { twap: 100, latency: 300, rate: 40 },
        premium: { twap: 0, latency: 200, rate: 4000 },
        premium_1: { twap: 0, latency: 195, rate: 5000 },
        premium_6: { twap: 0, latency: 150, rate: 24000 },
      }),
    )

    expect(configs.standard.latencyImprovement).toBe('-')
    expect(configs.premium[0]?.latencyImprovement).toBe('-')
    expect(configs.premium[1]?.latencyImprovement).toBe('2.5%')
    expect(configs.premium[6]?.latencyImprovement).toBe('25%')
    expect(configs.premium[2]?.latencyImprovement).toBe('5%')
  })
})

describe('getPlanFees', () => {
  it('charges a tier the backend does not list at the top premium rate', () => {
    currentEnv.env = 'robinhood-mainnet'
    const configs = toFeeTierConfigs(resolveFeeTiers(null))

    expect(getPlanFees(configs, 'premium_7')).toEqual(getPlanFees(configs, 'premium_6'))
    expect(getPlanFees(configs, null).twap).toBe(0.0001)
  })
})
