import type { Fallbacks } from './types'

export type { Fallbacks, TokensOnlyFallbacks } from './types'

export const fallbackData: {
  current: Fallbacks | null
  tokens: Fallbacks['tokens'] | null
  ready: Promise<void>
} = {
  current: null,
  tokens: null,
  ready: Promise.resolve(),
}
