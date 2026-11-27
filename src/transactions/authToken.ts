import { transactionConfig } from '../lib/transactionConfig'

const memoryCacheAuthToken: Record<number, string> = {}
const tokenDeadline: Record<number, number> = {}

const createNewAuthToken = async (accountIndex: number): Promise<string> => {
  const { token, deadline } = await transactionConfig.signers.createAuthToken({
    accountIndex,
    apiKeyIndex: transactionConfig.getApiKeyIndex(),
  })

  if (!token) {
    throw new Error(`Could not create auth token for account index ${accountIndex}`)
  }

  memoryCacheAuthToken[accountIndex] = token
  tokenDeadline[accountIndex] = deadline

  return token
}

const isTokenExpiringSoon = (accountIndex: number): boolean => {
  const deadline = tokenDeadline[accountIndex]
  if (!deadline) {
    return true
  }

  return deadline * 1000 - Date.now() < 10 * 60 * 1000
}

export const isRegistered = (accountIndex: number) => transactionConfig.isRegistered(accountIndex)

export const getOrCreateAuthToken = async (accountIndex?: number) => {
  if (!accountIndex) {
    return undefined
  }

  if (!isRegistered(accountIndex)) {
    return undefined
  }

  const cachedToken = memoryCacheAuthToken[accountIndex]
  if (cachedToken && !isTokenExpiringSoon(accountIndex)) {
    return { token: cachedToken }
  }

  return { token: await createNewAuthToken(accountIndex) }
}

export const resetAuthToken = () => {
  Object.keys(memoryCacheAuthToken).forEach((key) => {
    delete memoryCacheAuthToken[Number(key)]
    delete tokenDeadline[Number(key)]
  })
}

// Accept both current and legacy invalid-signature rejection codes.
const INVALID_SIGNATURE_CODE_BY_STATUS: Record<number, number> = {
  400: 29500,
  401: 20013,
}

/**
 * Whether a failed response says the auth token was signed by a key the account
 * no longer has, e.g. after another session replaced it. Other auth failures,
 * such as an expired token, are not: a new token from the same key fixes those.
 * Reads a clone, so the caller can still consume the body.
 */
export const isInvalidSignatureRejection = async (response: Response): Promise<boolean> => {
  const code = INVALID_SIGNATURE_CODE_BY_STATUS[response.status]
  if (code === undefined) return false
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null)
  if (typeof body !== 'object' || body === null) return false
  return (
    'code' in body &&
    body.code === code &&
    'message' in body &&
    typeof body.message === 'string' &&
    body.message.includes('invalid signature')
  )
}
