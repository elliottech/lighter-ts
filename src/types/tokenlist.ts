import type { Token as ApiToken } from 'zklighter-perps'

// backend_symbol is optional on the wire; it is normalized to the display symbol
// at the token-list boundary, so consumers always get it.
export type Token = ApiToken & { backend_symbol: string }

export type TokenCategory =
  | 'ALL'
  | 'NEW'
  | 'UPCOMING'
  | 'MAJOR'
  | 'DEFI'
  | 'LAYER_1'
  | 'LAYER_2'
  | 'MEMES'
  | 'AI'
  | 'STOCK'
  | 'ETF'
  | 'FX'
  | 'COMMODITIES'
  | 'PRE_LAUNCH'
  | 'KRW'
  | 'UPCOMING_EARNINGS'
  | 'PRE_IPO'
  | 'COMPUTE'
  | 'HOT'

export const TOKEN_CATEGORY_ORDER: TokenCategory[] = [
  'ALL',
  'NEW',
  'UPCOMING',
  'MAJOR',
  'PRE_LAUNCH',
  'DEFI',
  'STOCK',
  'ETF',
  'FX',
  'COMMODITIES',
  'KRW',
  'PRE_IPO',
  'COMPUTE',
  'UPCOMING_EARNINGS',
  'LAYER_1',
  'LAYER_2',
  'MEMES',
  'AI',
  'HOT',
]

export type MarketType = 'ALL' | 'SPOT' | 'PERPS'
export type MarketCategory = 'ALL' | 'FAVORITES' | 'CRYPTO' | 'RWA'
