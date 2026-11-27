import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkRegisteredAccountIndex, readAllowedAccountIndex, readWsPort } from './serverConfig'

const NAME = 'STRATEGIES_WS_ALLOWED_ACCOUNT_INDEX'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('readAllowedAccountIndex', () => {
  it('reads the account index', () => {
    vi.stubEnv(NAME, '12345')
    expect(readAllowedAccountIndex(true)).toBe(12345)
  })

  it.each([true, false])('allows any account with any, when required is %s', (required) => {
    vi.stubEnv(NAME, 'any')
    expect(readAllowedAccountIndex(required)).toBeNull()
  })

  it('allows any account when unset and not required', () => {
    vi.stubEnv(NAME, '')
    expect(readAllowedAccountIndex(false)).toBeNull()
  })

  it('refuses to start when unset and required', () => {
    vi.stubEnv(NAME, '')
    expect(() => readAllowedAccountIndex(true)).toThrow(
      `${NAME} is required with STRATEGIES_TLS_IP`,
    )
  })

  it.each(['-1', 'all', '1.5'])('refuses %s', (value) => {
    vi.stubEnv(NAME, value)
    expect(() => readAllowedAccountIndex(false)).toThrow(`${NAME} must be an integer`)
  })
})

describe('checkRegisteredAccountIndex', () => {
  it.each([
    [12345, null],
    [12345, 12345],
    [null, 678],
  ])('starts with allowed %s and registered %s', (allowed, registered) => {
    expect(() => checkRegisteredAccountIndex(allowed, registered)).not.toThrow()
  })

  it('refuses a store registered to another account', () => {
    expect(() => checkRegisteredAccountIndex(12345, 678)).toThrow(
      `${NAME}=12345 but the store is registered to account 678: set it to 678`,
    )
  })
})

describe('readWsPort', () => {
  it('defaults to 8787 without TLS and 443 with it', () => {
    vi.stubEnv('STRATEGIES_WS_PORT', '')
    expect(readWsPort(null)).toBe(8787)
    expect(readWsPort(80)).toBe(443)
  })

  it('reads another port than the ACME one', () => {
    vi.stubEnv('STRATEGIES_WS_PORT', '8443')
    expect(readWsPort(80)).toBe(8443)
    expect(readWsPort(null)).toBe(8443)
  })

  it('refuses the ACME http-01 port', () => {
    vi.stubEnv('STRATEGIES_WS_PORT', '80')
    expect(() => readWsPort(80)).toThrow(
      'STRATEGIES_WS_PORT and STRATEGIES_ACME_HTTP_PORT are both 80',
    )
  })
})
