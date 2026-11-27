import { afterEach, describe, expect, it } from 'vitest'

import {
  type Env,
  currentEnv,
  getMaintenanceKeysOf,
  isGeoBlockEnabled,
  shouldUseECDSA,
  isLivePointsEnabled,
  isMainnetEnv,
  isRobinhoodCopy,
  isRobinhoodEnv,
} from './env'

const ENVS: Env[] = ['robinhood-mainnet', 'robinhood-testnet', 'mainnet', 'testnet', 'staging']

const across = (predicate: () => boolean | string) =>
  ENVS.map((env) => {
    currentEnv.env = env
    return predicate()
  })

afterEach(() => {
  currentEnv.env = null!
})

describe('env predicates', () => {
  it.each<Env>(['local', ...ENVS])('disables ECDSA api keys on %s', (env) => {
    currentEnv.env = env
    expect(shouldUseECDSA()).toBe(false)
  })
  it('treats robinhood-mainnet and robinhood-testnet as Robinhood', () => {
    expect(across(isRobinhoodEnv)).toEqual([true, true, false, false, false])
  })

  it('treats robinhood-mainnet and mainnet as mainnet', () => {
    expect(across(isMainnetEnv)).toEqual([true, false, true, false, false])
  })

  it('is not mainnet before initCommonPackage sets the env', () => {
    expect(isMainnetEnv()).toBe(false)
    expect(isGeoBlockEnabled()).toBe(false)
  })
})

describe('behavior predicates', () => {
  it('keeps Robinhood-only behavior on Robinhood', () => {
    expect(across(isRobinhoodCopy)).toEqual([true, true, false, false, false])
    expect(across(isLivePointsEnabled)).toEqual([true, true, false, false, false])
  })

  it('geo-blocks on mainnets', () => {
    expect(across(isGeoBlockEnabled)).toEqual([true, false, true, false, false])
  })

  it('reads the instance keys for the maintenance timer', () => {
    expect(ENVS.map((env) => getMaintenanceKeysOf(env).timer)).toEqual([
      'rh_maintenance_timer',
      'rh_maintenance_timer',
      'maintenance_timer',
      'test_maintenance_timer',
      'test_maintenance_timer',
    ])
  })

  it('derives the keys of any other instance from its env name, never Lighter ones', () => {
    expect(getMaintenanceKeysOf('acme-mainnet' as Env)).toEqual({
      timer: 'acme_maintenance_timer',
      body: 'acme_maintenance_scheduled_body',
    })
    expect(getMaintenanceKeysOf('acme-testnet' as Env)).toEqual({
      timer: 'acme_maintenance_timer',
      body: 'test_maintenance_scheduled_body',
    })
  })
})
