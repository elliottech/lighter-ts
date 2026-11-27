import { randomBytes } from 'node:crypto'
import { type Signers, getECDSAPubKeyExpiredAt } from '../..'
import type { StrategiesServerRegistration } from '../wsProtocol'

// The signer only checks an L1Sig's length, and the key's signature does not cover it.
const PLACEHOLDER_L1_SIG = `0x${'00'.repeat(65)}`

export interface RegistrationTxRequest {
  seed: string
  chainId: number
  accountIndex: number
  apiKeyIndex: number
  nonce: number
}

export interface SignedRegistrationTx {
  publicKey: string
  /** With `L1Sig` empty. */
  txInfo: string
  expiredAt: number
}

type RegistrationTxSigners = Pick<Signers, 'createClient' | 'signChangePubKey'>

/** Signs the seed key's changePubKey, for the frontend to add the wallet's `L1Sig`. */
export const signRegistrationTx = async (
  signers: RegistrationTxSigners,
  { seed, chainId, accountIndex, apiKeyIndex, nonce }: RegistrationTxRequest,
): Promise<SignedRegistrationTx> => {
  const transactionExpiredAt = getECDSAPubKeyExpiredAt()
  const { pk } = await signers.createClient({
    seed,
    chainId,
    accountIndex,
    nonce,
    apiKeyIndex,
    expiredAt: transactionExpiredAt,
    skipNonce: true,
  })
  const { txInfo } = await signers.signChangePubKey({
    accountIndex,
    signature: PLACEHOLDER_L1_SIG,
    nonce,
    apiKeyIndex,
    expiredAt: transactionExpiredAt,
  })
  const tx = JSON.parse(txInfo) as Record<string, unknown>
  const expiredAt = tx.ExpiredAt
  if (typeof expiredAt !== 'number' || !Number.isSafeInteger(expiredAt)) {
    throw new Error('The signed changePubKey has no ExpiredAt')
  }
  return { publicKey: pk, txInfo: JSON.stringify({ ...tx, L1Sig: '' }), expiredAt }
}

/** Where a worker whose signer was rejected registers a new key. */
export interface WorkerRegistrationTarget {
  accountIndex: number
  apiKeyIndex: number
  chainId: number
  /** The pending seed to sign for again; a new one is generated when null. */
  seed: string | null
}

/** A registration with the seed it was signed for, which only the server keeps. */
export type SignedWorkerRegistration = StrategiesServerRegistration & { seed: string }

const generateHexSeed = () => randomBytes(32).toString('hex')

/**
 * Signs the changePubKey of the target's seed, or of a new one, with the
 * nonce the backend expects next. Replaces the wasm client of the account.
 */
export const signWorkerRegistration = async (
  { accountIndex, apiKeyIndex, chainId, seed }: WorkerRegistrationTarget,
  {
    signers,
    fetchNonce,
    generateSeed = generateHexSeed,
  }: {
    signers: RegistrationTxSigners
    fetchNonce: (accountIndex: number, apiKeyIndex: number) => Promise<number>
    generateSeed?: () => string
  },
): Promise<SignedWorkerRegistration> => {
  const registrationSeed = seed ?? generateSeed()
  const nonce = await fetchNonce(accountIndex, apiKeyIndex)
  const tx = await signRegistrationTx(signers, {
    seed: registrationSeed,
    chainId,
    accountIndex,
    apiKeyIndex,
    nonce,
  })
  return { seed: registrationSeed, accountIndex, apiKeyIndex, nonce, ...tx }
}
