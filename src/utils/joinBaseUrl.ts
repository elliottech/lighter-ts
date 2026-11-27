export const joinBaseUrl = (baseUrl: string, path: string, query = ''): string => {
  const queryStart = baseUrl.indexOf('?')
  const base = queryStart === -1 ? baseUrl : baseUrl.slice(0, queryStart)
  const baseQuery = queryStart === -1 ? '' : baseUrl.slice(queryStart + 1)
  const fullQuery = [baseQuery, query].filter(Boolean).join('&')
  return `${base}${path}${fullQuery ? `?${fullQuery}` : ''}`
}
