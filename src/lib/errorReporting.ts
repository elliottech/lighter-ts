export type CaptureException = (exception: unknown, hint?: unknown) => string

export const errorReporting: { captureException: CaptureException } = {
  captureException: () => '',
}
