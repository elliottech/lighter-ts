import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkStoreDir,
  readEnv,
  readIntEnv,
  readIntListEnv,
  readOneOfEnv,
  readOriginsEnv,
  readUrlEnv,
} from './serverEnv'

const NAME = 'STRATEGIES_TEST_ENV'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('checkStoreDir', () => {
  const cwd = process.cwd()

  it.each(['.', './', '..', '/', cwd, join(cwd, 'sub', '..')])(
    'refuses %s, which holds the current directory',
    (dir) => {
      expect(() => checkStoreDir(dir, [cwd])).toThrow('set it to a directory of its own')
    },
  )

  it.each(['store', '.strategies-store', `${cwd}-store`, join('..', `${basename(cwd)}-store`)])(
    'accepts %s',
    (dir) => {
      expect(checkStoreDir(dir, [cwd])).toBe(dir)
    },
  )

  it('refuses a store that holds any of the dirs', () => {
    expect(() => checkStoreDir('/data', ['/elsewhere', '/data/home'])).toThrow(
      'STRATEGIES_STORE_DIR=/data holds /data/home',
    )
  })
})

describe('readEnv', () => {
  it('treats missing and blank values as unset', () => {
    expect(readEnv(NAME)).toBeUndefined()
    vi.stubEnv(NAME, '   ')
    expect(readEnv(NAME)).toBeUndefined()
  })

  it('trims values', () => {
    vi.stubEnv(NAME, ' abc ')
    expect(readEnv(NAME)).toBe('abc')
  })
})

describe('readIntEnv', () => {
  it.each(['', '  '])('rejects a blank value %j', (value) => {
    vi.stubEnv(NAME, value)
    expect(() => readIntEnv(NAME, 0, 10)).toThrow(`${NAME} is required`)
  })

  it('rejects a missing value', () => {
    expect(() => readIntEnv(NAME, 0, 10)).toThrow(`${NAME} is required`)
  })

  it('accepts an explicit 0', () => {
    vi.stubEnv(NAME, '0')
    expect(readIntEnv(NAME, 0, 10)).toBe(0)
  })

  it('falls back when unset or blank, not when invalid', () => {
    expect(readIntEnv(NAME, 1, 10, 7)).toBe(7)
    vi.stubEnv(NAME, '')
    expect(readIntEnv(NAME, 1, 10, 7)).toBe(7)
    vi.stubEnv(NAME, '0')
    expect(() => readIntEnv(NAME, 1, 10, 7)).toThrow(`${NAME} must be an integer from 1 to 10`)
  })

  it.each(['1.5', '-1', '1e3', '0x10', 'abc', '11', '9007199254740993'])('rejects %j', (value) => {
    vi.stubEnv(NAME, value)
    expect(() => readIntEnv(NAME, 0, 10)).toThrow(`${NAME} must be an integer from 0 to 10`)
  })
})

describe('readOneOfEnv', () => {
  it('falls back when unset', () => {
    expect(readOneOfEnv(NAME, ['a', 'b'], 'a')).toBe('a')
  })

  it('rejects values outside the list', () => {
    vi.stubEnv(NAME, 'c')
    expect(() => readOneOfEnv(NAME, ['a', 'b'], 'a')).toThrow(`${NAME} must be one of a, b`)
  })
})

describe('readUrlEnv', () => {
  it('falls back when blank', () => {
    vi.stubEnv(NAME, '')
    expect(readUrlEnv(NAME, ['https:'], 'https://example.com')).toBe('https://example.com')
  })

  it('rejects invalid URLs and wrong protocols', () => {
    vi.stubEnv(NAME, 'not a url')
    expect(() => readUrlEnv(NAME, ['https:'], 'https://example.com')).toThrow('must be a URL')
    vi.stubEnv(NAME, 'http://example.com')
    expect(() => readUrlEnv(NAME, ['https:'], 'https://example.com')).toThrow('must use https:')
  })
})

describe('readIntListEnv', () => {
  it('falls back when unset or blank', () => {
    expect(readIntListEnv(NAME, 0, 9, [1, 2])).toEqual([1, 2])
    vi.stubEnv(NAME, ' ')
    expect(readIntListEnv(NAME, 0, 9, [1, 2])).toEqual([1, 2])
  })

  it('splits and trims a comma-separated list', () => {
    vi.stubEnv(NAME, ' 0 , 2,5,')
    expect(readIntListEnv(NAME, 0, 9, [])).toEqual([0, 2, 5])
  })

  it('rejects a list with no entry', () => {
    vi.stubEnv(NAME, ' , ,')
    expect(() => readIntListEnv(NAME, 0, 9, [1])).toThrow('at least one integer')
  })

  it.each(['10', '-1', '1.5', 'a', '0x1'])('rejects %j', (value) => {
    vi.stubEnv(NAME, `0,${value}`)
    expect(() => readIntListEnv(NAME, 0, 9, [])).toThrow(`got "${value}"`)
  })
})

describe('readOriginsEnv', () => {
  it('falls back when unset or blank', () => {
    expect(readOriginsEnv(NAME, ['https://a.example'])).toEqual(['https://a.example'])
    vi.stubEnv(NAME, ' ')
    expect(readOriginsEnv(NAME, ['https://a.example'])).toEqual(['https://a.example'])
  })

  it('splits and trims a comma-separated list', () => {
    vi.stubEnv(NAME, ' https://a.example , http://localhost:3001,')
    expect(readOriginsEnv(NAME, [])).toEqual(['https://a.example', 'http://localhost:3001'])
  })

  it.each([
    'https://a.example/',
    'https://a.example/path',
    'a.example',
    'ws://a.example',
    '*',
    'null',
  ])('rejects %j, which is not an exact http(s) origin', (value) => {
    vi.stubEnv(NAME, value)
    expect(() => readOriginsEnv(NAME, [])).toThrow(`got "${value}"`)
  })
})
