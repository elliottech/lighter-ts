import type { Platform } from '../types/Platform'
import type { Signers } from '../types/signers'

export const transactionConfig: {
  signers: Signers
  getApiKeyIndex: () => number
  getPlatform: () => Platform
  isRegistered: (accountIndex: number) => boolean
  skipNonce: boolean
} = {
  signers: null!,
  getApiKeyIndex: null!,
  getPlatform: null!,
  isRegistered: null!,
  skipNonce: false,
}
