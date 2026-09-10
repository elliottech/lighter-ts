export const AIRDROP_SENDER_L1 = '0xc195204fa86948FC80364464cae4d3A689F01896'
export const COMPETITION_REWARDS_L1 = '0x5Cb8F8b221FF50DBE4B64275e5aa2Ac85e5191e0'
export const REFERRAL_PAYOUT_L1 = '0xF516F26A52bc61DB91b27242CC575AeF2D5362D6'
export const REFERRAL_PAYOUT_L1_2 = '0x817645592d5f7BB7F4F1b027B7f5277f28d12805'
export const REFERRAL_PAYOUT_ACCOUNT_INDEX = 723726
export const REFERRAL_PAYOUT_ACCOUNT_INDEX_2 = 740914
export const INCENTIVE_ACCOUNT_L1_ADDRESSES = [
  '0x23aC0adc2be357d7400211589478c5acF225E42e',
  '0x3deC7BCFb0b28dE93F04210DbAD751cB7Fc0b11c',
] as const
export const DEPOSIT_PROVIDER_L1 = '0xf70da97812CB96acDF810712Aa562db8dfA3dbEF'
export const DEPOSIT_PROVIDER_ACCOUNT_INDEX = 508431
export const WITHDRAWAL_PROVIDER_L1_ADDRESSES = [
  '0x865eb9bAa5492cEf598ADf7AFb1038654fcB7081',
  '0xc2679Fa87bf28C29D3bc677a4061501c9e10c706',
  '0xB7b102e4e3D5AC84d3525C24b83F3Dc267F8ceB1',
  '0x85594C5D28AC8bF20e6Ef0b9620F648F3737607F',
  '0x1ecC750CB33155cf62C3efDF43001ED1B41a6c02',
] as const
export const WITHDRAWAL_PROVIDER_ACCOUNT_INDICES = [723071, 731032, 731033, 722011, 730948]

export const TX_STATUSES = {
  StatusFailed: 0,
  StatusPending: 1,
  StatusExecuted: 2,
  StatusPacked: 3,
  StatusCommitted: 4,
  StatusVerified: 5,
} as const

export enum OrderDirections {
  Short,
  Long,
}

const ASKS_TITLE_KEY_MAP = { spot: 'sell', perps: 'short', all: 'sell_short' } as const

const BIDS_TITLE_KEY_MAP = { spot: 'buy', perps: 'long', all: 'buy_long' } as const

export const getOrderSideOptions = (type: 'spot' | 'perps' | 'all' = 'all') =>
  [
    { key: 'all', titleKey: 'all', icon: 'allOrders' },
    { key: 'asks', titleKey: ASKS_TITLE_KEY_MAP[type], icon: 'asks' },
    { key: 'bids', titleKey: BIDS_TITLE_KEY_MAP[type], icon: 'bids' },
  ] as const
export type OrderSide = 'all' | 'asks' | 'bids'

export const MAX_MARKET_ORDER_SLIPPAGE = 10
export const MAX_SLTP_ORDER_SLIPPAGE = 10
export const DEFAULT_SLTP_ORDER_SLIPPAGE = 1
export const DEFAULT_MARKET_ORDER_SLIPPAGE = 1

export const MARGIN_FRACTION_TICK = 10000
export const PREMIUM_ORDER_BATCH_SIZE = 50
export const FREE_ORDER_BATCH_SIZE = 40

export const TOTAL_LIT_SUPPLY = 1_000_000_000
export const CIRCULATING_LIT_SUPPLY_BASE = 250_000_000
export const BURNED_LIT_AMOUNT = 15_638_702

export const MAX_ACCOUNT_INDEX_LIMIT = 281474976710655 // MaxAccountIndex int64 = 281474976710654 // (1 << 48) - 2
