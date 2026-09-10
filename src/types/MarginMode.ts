export const MarginMode = {
  CROSS: 0,
  ISOLATED: 1,
} as const
export type MarginMode = (typeof MarginMode)[keyof typeof MarginMode]
