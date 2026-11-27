import type { Layer1BasicInfo, SystemConfig } from 'zklighter-perps'

import type { Env } from '../lib/env'
import type { BackendFeeTiers } from '../types/user-tiers'

export type Fallbacks = {
  env: Env
  tokens?: { tokens: object[] }
  orderBookMetas: { order_book_details: object[]; spot_order_book_details: object[] }
  assetMetas: { asset_details: object[] }
  l1Info: Layer1BasicInfo
  systemConfig: SystemConfig
  feeTiers: BackendFeeTiers
}

export type TokensOnlyFallbacks = Pick<Fallbacks, 'env'> & Required<Pick<Fallbacks, 'tokens'>>
