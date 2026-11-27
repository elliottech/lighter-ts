import tokens from '../robinhood-mainnet/tokens.json'
import type { Fallbacks } from '../types'

import assetMetas from './assetMetas.json'
import feeTiers from './feeTiers.json'
import l1Info from './l1Info.json'
import orderBookMetas from './orderBookMetas.json'
import systemConfig from './systemConfig.json'

const fallbacks: Fallbacks = {
  env: 'robinhood-testnet',
  assetMetas,
  feeTiers,
  l1Info,
  orderBookMetas,
  systemConfig,
  tokens,
}

export default fallbacks
