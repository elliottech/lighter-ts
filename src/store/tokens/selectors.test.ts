import { describe, expect, it } from 'vitest'

import type { Token } from '../../types/tokenlist'

import { selectPreIpoCoins } from './selectors'

const getPreIpoCoins = selectPreIpoCoins.resultFunc

const token = (backend_symbol: string, categories: string[]) =>
  ({ backend_symbol, categories }) as unknown as Token

describe('selectPreIpoCoins', () => {
  it('collects the backend symbols of tokens in the PRE_IPO category', () => {
    const tokens = [
      token('OPENAI', ['STOCK', 'PRE_IPO']),
      token('ANTHROPIC', ['PRE_IPO', 'STOCK']),
      token('TSLA', ['STOCK']),
      token('ETH', ['MAJOR']),
    ]

    expect(getPreIpoCoins(tokens)).toEqual(new Set(['OPENAI', 'ANTHROPIC']))
  })

  it('is empty before the token list loads', () => {
    expect(getPreIpoCoins(null)).toEqual(new Set())
  })
})
