export const parseRequestBodyToFormData = (request: Record<string, unknown>): FormData => {
  const formData = new FormData()
  Object.entries(request).forEach(([key, value]) => {
    formData.append(key, String(value))
  })
  return formData
}
