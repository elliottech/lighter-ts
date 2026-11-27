import { describe, expect, it } from 'vitest'

import { selectIsAdvancedTWAP } from './selectors'

describe('selectIsAdvancedTWAP', () => {
  it('uses the advanced TWAP parameter', () => {
    expect(selectIsAdvancedTWAP({}, { isAdvancedTWAP: true })).toBe(true)
  })

  it('defaults to false', () => {
    expect(selectIsAdvancedTWAP({}, {})).toBe(false)
    expect(selectIsAdvancedTWAP({})).toBe(false)
  })
})
