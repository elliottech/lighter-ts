export type ToastableError = { code?: number; message?: string; response?: Response }

export type ShowToastFromError = (error: ToastableError | null | undefined) => void

export const errorToast: { showToastFromError: ShowToastFromError } = {
  showToastFromError: () => {},
}
