import type { Platform } from '../types/Platform'
import type { Signers } from '../types/signers'
import type { StrategyOrderKind } from '../types/StrategyOrderKind'

export type GenerateClientOrderIndex = (kind?: StrategyOrderKind) => Promise<number>

export const transactionConfig: {
  signers: Signers
  getApiKeyIndex: () => number
  getPlatform: () => Platform
  generateClientOrderIndex: GenerateClientOrderIndex
  isRegistered: (accountIndex: number) => boolean
  skipNonce: boolean
} = {
  signers: null!,
  getApiKeyIndex: null!,
  getPlatform: null!,
  generateClientOrderIndex: null!,
  isRegistered: null!,
  skipNonce: false,
}
