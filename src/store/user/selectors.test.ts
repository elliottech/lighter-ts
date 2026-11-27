import { beforeEach, describe, expect, it } from 'vitest'

import { useLighterStore } from '../useLighterStore'
import { accountChangeModalDefaults } from './createUserSlice'
import { selectReferralInfoSource } from './selectors'

describe('selectReferralInfoSource', () => {
  beforeEach(() => {
    useLighterStore.setState(useLighterStore.getInitialState())
  })

  it('has no source until the invite modal is opened with one', () => {
    expect(selectReferralInfoSource(useLighterStore.getState())).toBeNull()
  })

  it('returns the source the invite modal was opened with', () => {
    useLighterStore.setState({ showReferralInfo: true, referralInfoSource: 'savings' })

    expect(selectReferralInfoSource(useLighterStore.getState())).toBe('savings')
  })

  it('is cleared with the invite modal on an account change', () => {
    useLighterStore.setState({ showReferralInfo: true, referralInfoSource: 'savings' })

    useLighterStore.setState(accountChangeModalDefaults)

    expect(selectReferralInfoSource(useLighterStore.getState())).toBeNull()
  })
})
