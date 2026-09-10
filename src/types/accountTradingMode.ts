export const AccountTradingMode = {
  CLASSIC: 0,
  UNIFIED: 1,
} as const
export type AccountTradingMode = (typeof AccountTradingMode)[keyof typeof AccountTradingMode]
