import { describe, expect, it } from 'vitest'

import { joinBaseUrl } from './joinBaseUrl'

describe('joinBaseUrl', () => {
  it('appends the path and query to a plain base', () => {
    expect(joinBaseUrl('https://api.example', '/location')).toBe('https://api.example/location')
    expect(joinBaseUrl('wss://api.example/stream', '', 'encoding=json')).toBe(
      'wss://api.example/stream?encoding=json',
    )
  })

  it('keeps a query carried by the base after the path', () => {
    expect(joinBaseUrl('https://api.example?password=abc', '/location')).toBe(
      'https://api.example/location?password=abc',
    )
    expect(joinBaseUrl('wss://api.example/stream?password=abc', '', 'encoding=json')).toBe(
      'wss://api.example/stream?password=abc&encoding=json',
    )
  })
})
