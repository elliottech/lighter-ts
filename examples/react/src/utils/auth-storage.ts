import { type RefinementCtx, ZodIssueCode, z } from 'zod'

const parseJsonPreprocessor = (value: unknown, ctx: RefinementCtx) => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (e) {
      ctx.addIssue({
        code: ZodIssueCode.custom,
        message: (e as Error).message,
      })
    }
  }

  return value
}

const signatureRecordSchema = z.object({ pk: z.string(), seed: z.string() })
const signatureSchema = z.preprocess(
  parseJsonPreprocessor,
  z.record(
    z.string(), // account index
    z.record(
      z.string(), // api key index
      signatureRecordSchema,
    ),
  ),
)

type SignatureRecord = z.infer<typeof signatureRecordSchema>
type Signatures = z.infer<typeof signatureSchema>

const LOCALSTORAGE_SIGNATURE_KEY = 'auth'
const readLSSignature = () =>
  signatureSchema.safeParse(localStorage.getItem(LOCALSTORAGE_SIGNATURE_KEY))
const writeLSSignature = (value: Signatures) =>
  localStorage.setItem(LOCALSTORAGE_SIGNATURE_KEY, JSON.stringify(value))
export const removeLSSignature = () => localStorage.removeItem(LOCALSTORAGE_SIGNATURE_KEY)

export const readLSAccountSignature = (accountIndex: number, apiKeyIndex: number) => {
  const accountSignatures = readLSSignature().data?.[accountIndex]
  return accountSignatures?.[apiKeyIndex]
}

export const writeLSAccountSignature = (
  accountIndex: number,
  apiKeyIndex: number,
  signature: SignatureRecord,
) => {
  const signatures = readLSSignature().data ?? {}
  const accountSignatures = signatures[accountIndex]

  writeLSSignature({
    ...signatures,
    [accountIndex]: {
      ...accountSignatures,
      [apiKeyIndex]: signature,
    },
  })
}

const accountIndexSchema = z.preprocess(parseJsonPreprocessor, z.number())
export const readLSLastAccountIndex = () =>
  accountIndexSchema.safeParse(localStorage.getItem('lastAccountIndex'))
export const writeLSLastAccountIndex = (value: z.infer<typeof accountIndexSchema>) =>
  localStorage.setItem('lastAccountIndex', JSON.stringify(value))
export const removeLSLastAccountIndex = () => localStorage.removeItem('lastAccountIndex')
