import { ResponseError } from 'zklighter-perps'

function getErrorObj(error: unknown) {
  if (typeof error !== 'object') {
    return
  }

  if (Array.isArray(error)) {
    return
  }

  if (error === null) {
    return
  }

  return error
}

type CodegenResponse = { json(): Promise<unknown>; status: number }

export function hasCodegenResponse(error: unknown): error is { response: CodegenResponse } {
  if (!error || typeof error !== 'object' || !('response' in error)) {
    return false
  }

  if (error.response instanceof Response) {
    return true
  }

  if (error instanceof ResponseError) {
    return true
  }

  if (typeof (error.response as { json?: unknown }).json === 'function') {
    return true
  }

  return false
}

export function getErrorObjStatusCode(error: unknown) {
  const errorObj = getErrorObj(error)

  if (!errorObj) {
    return
  }

  if (hasCodegenResponse(errorObj)) {
    return errorObj.response.status
  }

  // Fallback for errors with direct status property
  if ('status' in errorObj && typeof errorObj.status === 'number') {
    return errorObj.status
  }

  return
}

export const parseErrorFromCodegen = async (error: unknown) => {
  if (hasCodegenResponse(error)) {
    return (await error.response.json()) as { code: number; message: string }
  }

  console.error('Unknown codegen error', error)
  throw error
}
