import { useLighterStore } from '../..'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACCOUNT_LIMITS_REFRESH_MS,
  getStrategyIntegratorFees,
  initWorkerAccountFees,
  refreshStrategyUserTier,
} from './workerAccountFees'

const systemConfig = vi.hoisted(() => vi.fn())
const accountLimits = vi.hoisted(() => vi.fn())

vi.mock('../..', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../..')>()),
  apis: {
    infoApi: { systemConfig },
    accountApi: { accountLimits },
  },
}))

const venueConfig = {
  ...useLighterStore.getInitialState().systemConfig,
  fee_collector_account_index: 77,
  max_integrator_perps_taker_fee: 1000,
  max_integrator_perps_maker_fee: 50,
}

describe('initWorkerAccountFees', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useLighterStore.setState(useLighterStore.getInitialState(), true)
    systemConfig.mockReset().mockResolvedValue(venueConfig)
    accountLimits.mockReset().mockResolvedValue({ user_tier: 'plus' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the account tier and the venue system config', async () => {
    await initWorkerAccountFees(42, false)
    expect(accountLimits).toHaveBeenCalledWith({ account_index: 42 })
    expect(useLighterStore.getState().userTier).toBe('plus')
    expect(useLighterStore.getState().systemConfig).toBe(venueConfig)
  })

  it('refreshes the tier at the main thread cadence', async () => {
    await initWorkerAccountFees(42, false)
    accountLimits.mockResolvedValue({ user_tier: 'premium' })
    await vi.advanceTimersByTimeAsync(ACCOUNT_LIMITS_REFRESH_MS)
    expect(accountLimits).toHaveBeenCalledTimes(2)
    expect(useLighterStore.getState().userTier).toBe('premium')
  })

  it('keeps the last tier when a refresh fails', async () => {
    await initWorkerAccountFees(42, false)
    accountLimits.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(ACCOUNT_LIMITS_REFRESH_MS)
    expect(useLighterStore.getState().userTier).toBe('plus')
  })

  it('reloads the tier on demand for a new strategy', async () => {
    await initWorkerAccountFees(42, false)
    accountLimits.mockResolvedValue({ user_tier: 'standard' })
    await refreshStrategyUserTier()
    expect(accountLimits).toHaveBeenLastCalledWith({ account_index: 42 })
    expect(useLighterStore.getState().userTier).toBe('standard')
  })

  it('keeps the last tier when an on-demand reload fails', async () => {
    await initWorkerAccountFees(42, false)
    accountLimits.mockRejectedValue(new Error('offline'))
    await expect(refreshStrategyUserTier()).resolves.toBeUndefined()
    expect(useLighterStore.getState().userTier).toBe('plus')
  })

  it('keeps the newest tier when an older reload answers last', async () => {
    await initWorkerAccountFees(42, false)
    let answerOlder = (_limits: { user_tier: string }) => {}
    accountLimits.mockReturnValueOnce(
      new Promise((resolve) => {
        answerOlder = resolve
      }),
    )
    const older = refreshStrategyUserTier()
    accountLimits.mockResolvedValueOnce({ user_tier: 'standard' })
    await refreshStrategyUserTier()
    answerOlder({ user_tier: 'premium' })
    await older
    expect(useLighterStore.getState().userTier).toBe('standard')
  })

  it('keeps an older reload when the newer one fails', async () => {
    await initWorkerAccountFees(42, false)
    let answerOlder = (_limits: { user_tier: string }) => {}
    accountLimits.mockReturnValueOnce(
      new Promise((resolve) => {
        answerOlder = resolve
      }),
    )
    const older = refreshStrategyUserTier()
    accountLimits.mockRejectedValueOnce(new Error('offline'))
    await refreshStrategyUserTier()
    answerOlder({ user_tier: 'premium' })
    await older
    expect(useLighterStore.getState().userTier).toBe('premium')
  })

  it('does not reload a pool account tier on demand', async () => {
    await initWorkerAccountFees(42, true)
    await refreshStrategyUserTier()
    expect(accountLimits).not.toHaveBeenCalled()
    expect(useLighterStore.getState().userTier).toBe('premium')
  })

  it('bills a pool account as premium, like main', async () => {
    await initWorkerAccountFees(42, true)
    expect(accountLimits).not.toHaveBeenCalled()
    expect(useLighterStore.getState().userTier).toBe('premium')
    await vi.advanceTimersByTimeAsync(ACCOUNT_LIMITS_REFRESH_MS)
    expect(accountLimits).not.toHaveBeenCalled()
  })

  it.each([
    ['premium', 'premium'],
    ['standard', 'standard'],
    ['unknown', 'standard'],
  ])('maps %s to %s', async (apiTier, userTier) => {
    accountLimits.mockResolvedValue({ user_tier: apiTier })
    await initWorkerAccountFees(42, false)
    expect(useLighterStore.getState().userTier).toBe(userTier)
  })

  it('fails without touching the store when a request fails', async () => {
    accountLimits.mockRejectedValue(new Error('offline'))
    await expect(initWorkerAccountFees(42, false)).rejects.toThrow('offline')
    expect(useLighterStore.getState().userTier).toBeNull()
  })
})

describe('getStrategyIntegratorFees', () => {
  beforeEach(() => {
    useLighterStore.setState(useLighterStore.getInitialState(), true)
    useLighterStore.setState({ systemConfig: venueConfig })
  })

  it('refuses to price an order before the tier is loaded', () => {
    expect(() => getStrategyIntegratorFees()).toThrow('Account tier is not loaded')
  })

  it('attaches the capped integrator fee for standard', () => {
    useLighterStore.setState({ userTier: 'standard' })
    expect(getStrategyIntegratorFees()).toEqual({
      accountIndex: 77,
      takerFee: 100,
      makerFee: 50,
    })
  })

  it.each(['plus', 'premium'] as const)('leaves %s on its tier fees', (userTier) => {
    useLighterStore.setState({ userTier })
    expect(getStrategyIntegratorFees()).toBeUndefined()
  })

  it('attaches nothing while the venue has no fee collector', () => {
    useLighterStore.setState({
      userTier: 'standard',
      systemConfig: { ...venueConfig, fee_collector_account_index: 0 },
    })
    expect(getStrategyIntegratorFees()).toBeUndefined()
  })
})
