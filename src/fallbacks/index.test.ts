import { describe, expect, it } from 'vitest'

import current from './current'
import local from './local'
import mainnet from './mainnet'
import robinhoodMainnet from './robinhood-mainnet'
import robinhoodTestnet from './robinhood-testnet'
import staging from './staging'
import testnet from './testnet'

const SUPPORTED_TIERS = ['standard', 'plus']

describe('env fallbacks', () => {
  it('current is a null placeholder', () => {
    expect(current).toBeNull()
  })

  it.each([
    ['mainnet', mainnet],
    ['staging', staging],
    ['testnet', testnet],
    ['robinhood-mainnet', robinhoodMainnet],
    ['robinhood-testnet', robinhoodTestnet],
  ] as const)('%s has a complete fallback for its own env', (env, fallbacks) => {
    const tierNames = fallbacks.feeTiers.user_tiers.map((tier) => tier.name)

    expect(fallbacks.env).toBe(env)
    expect(fallbacks.orderBookMetas.order_book_details.length).toBeGreaterThan(0)
    expect(fallbacks.assetMetas.asset_details.length).toBeGreaterThan(0)
    expect(tierNames).toEqual(expect.arrayContaining(SUPPORTED_TIERS))
    expect(tierNames.some((name) => name.startsWith('premium'))).toBe(true)
  })

  it.each([
    ['staging', staging, mainnet],
    ['testnet', testnet, mainnet],
    ['robinhood-testnet', robinhoodTestnet, robinhoodMainnet],
    ['local', local, mainnet],
  ] as const)('%s takes its tokens from another env', (_, fallbacks, source) => {
    expect(source.tokens!.tokens.length).toBeGreaterThan(0)
    expect(fallbacks.tokens).toBe(source.tokens)
  })

  it('local has tokens only, so it still waits for the API metas', () => {
    expect(local.env).toBe('local')
    expect(local).not.toHaveProperty('orderBookMetas')
    expect(local).not.toHaveProperty('assetMetas')
  })
})
