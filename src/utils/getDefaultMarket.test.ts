import { describe, expect, it } from 'vitest'

import type { PerpsOrderBookDetail, SpotOrderBookDetail } from '../types/compatibility'
import { getDefaultMarket } from './getDefaultMarket'

const perp = (market_id: number, symbol: string, hidden = false) =>
  ({ market_id, symbol, market_type: 'perp', market_config: { hidden } }) as PerpsOrderBookDetail
const spot = (market_id: number, symbol: string) =>
  ({ market_id, symbol, market_type: 'spot' }) as SpotOrderBookDetail

const eth = perp(0, 'ETH')
const btc = perp(1, 'BTC')
const lit = perp(120, 'LIT')
const litSpot = spot(2049, 'LIT/USDC')
const hiddenEth = perp(0, 'ETH', true)
const hiddenBtc = perp(1, 'BTC', true)

describe('getDefaultMarket', () => {
  it('returns the first preferred symbol that is listed', () => {
    expect(getDefaultMarket([eth, btc, lit], ['LIT', 'BTC'])).toBe(lit)
  })

  it('skips preferred symbols that are not listed', () => {
    expect(getDefaultMarket([eth, btc], ['LIT', 'BTC'])).toBe(btc)
  })

  it('matches a preferred symbol written with an underscore', () => {
    expect(getDefaultMarket([eth, litSpot], ['LIT_USDC'])).toBe(litSpot)
  })

  it('falls back to the first market when no preferred symbol is listed', () => {
    expect(getDefaultMarket([btc, eth], ['LIT'])).toBe(btc)
  })

  it('skips a hidden preferred market', () => {
    expect(getDefaultMarket([hiddenEth, btc], ['ETH', 'BTC'])).toBe(btc)
  })

  it('skips hidden markets when falling back to the first market', () => {
    expect(getDefaultMarket([hiddenEth, btc], ['LIT'])).toBe(btc)
  })

  it('still returns a market when every market is hidden', () => {
    expect(getDefaultMarket([hiddenEth, hiddenBtc], ['BTC'])).toBe(hiddenBtc)
  })

  it('returns undefined when there are no markets', () => {
    expect(getDefaultMarket([], ['LIT'])).toBeUndefined()
  })
})
