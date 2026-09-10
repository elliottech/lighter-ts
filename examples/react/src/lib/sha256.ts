import type { Sha256 } from 'lighter-ts'

const getCrypto = () =>
  typeof window !== 'undefined'
    ? window.crypto
    : (globalThis as typeof globalThis & { crypto?: Crypto }).crypto

export const sha256: Sha256 = {
  digest: async (data) => {
    const crypto = getCrypto()
    if (!crypto?.subtle) throw new Error('sha256: crypto.subtle is not available')
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as BufferSource)
    return new Uint8Array(hashBuffer)
  },
}
