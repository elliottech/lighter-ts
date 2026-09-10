import type { ShowToastFromError } from 'lighter-ts'

export const errorToast: { showToastFromError: ShowToastFromError } = {
  showToastFromError: (error) => {
    console.error(error)
  },
}
