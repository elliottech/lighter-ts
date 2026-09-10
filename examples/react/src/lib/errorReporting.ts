import type { CaptureException } from 'lighter-ts'

export const errorReporting: { captureException: CaptureException } = {
  captureException: (exception: unknown, hint?: unknown) => {
    console.error(exception, hint)
    return ''
  },
}
