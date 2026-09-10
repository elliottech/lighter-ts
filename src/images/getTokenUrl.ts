export const TOKEN_IMAGE_BASE_URL = 'https://assets.lighter.xyz/fe/token'

export const getTokenUrl = (logo: string, extension: string = 'svg') =>
  `${TOKEN_IMAGE_BASE_URL}/${logo}.${extension}`

export const CHAIN_ICON_MAP = {
  eth: `${TOKEN_IMAGE_BASE_URL}/eth.svg`,
  arb: `${TOKEN_IMAGE_BASE_URL}/arb.svg`,
  sol: `${TOKEN_IMAGE_BASE_URL}/sol.svg`,
  base: `${TOKEN_IMAGE_BASE_URL}/base.svg`,
  avalanche: `${TOKEN_IMAGE_BASE_URL}/avax.svg`,
  hl: `${TOKEN_IMAGE_BASE_URL}/hl.svg`,
  btc: `${TOKEN_IMAGE_BASE_URL}/btc.svg`,
  monad: `${TOKEN_IMAGE_BASE_URL}/mon.png`,
  tron: `${TOKEN_IMAGE_BASE_URL}/trx.svg`,
  polygon: `${TOKEN_IMAGE_BASE_URL}/matic.svg`,
  bnb: `${TOKEN_IMAGE_BASE_URL}/bnb.svg`,
  optimism: `${TOKEN_IMAGE_BASE_URL}/op.svg`,
  abstract: `${TOKEN_IMAGE_BASE_URL}/abstract.svg`,
  ethereal: `${TOKEN_IMAGE_BASE_URL}/ethereal.svg`,
  hood: `${TOKEN_IMAGE_BASE_URL}/hood.png`,
  ink: `${TOKEN_IMAGE_BASE_URL}/ink.svg`,
} as const

export type ChainIconType = keyof typeof CHAIN_ICON_MAP
