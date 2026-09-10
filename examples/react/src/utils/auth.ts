import { transactionConfig } from 'lighter-ts'
import { isRegistered } from './isRegistered'

const memoryCacheAuthToken: Record<number, string> = {}
const tokenDeadline: Record<number, number> = {}

const createNewAuthToken = async (accountIndex: number): Promise<string> => {
  const { token, deadline } = await transactionConfig.signers.createAuthToken({
    accountIndex,
    apiKeyIndex: transactionConfig.getApiKeyIndex(),
  })

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

export const getOrCreateAuthToken = async (accountIndex?: number) => {
  if (!accountIndex) {
    return undefined
  }

  if (!isRegistered(accountIndex)) {
    return undefined
  }

  if (!memoryCacheAuthToken[accountIndex] || isTokenExpiringSoon(accountIndex)) {
    await createNewAuthToken(accountIndex)
  }

  return { token: memoryCacheAuthToken[accountIndex]! }
}

export const resetAuthToken = () => {
  Object.keys(memoryCacheAuthToken).forEach((key) => {
    delete memoryCacheAuthToken[Number(key)]
    delete tokenDeadline[Number(key)]
  })
}
