export interface Sha256 {
  digest: (data: Uint8Array) => Promise<Uint8Array>
}

const notInitialized = (): Promise<Uint8Array> =>
  Promise.reject(new Error('sha256 not initialized — call initCommonPackage with sha256'))

export const sha256: Sha256 = {
  digest: notInitialized,
}
