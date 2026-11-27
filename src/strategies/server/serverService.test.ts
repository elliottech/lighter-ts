import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openServerDb } from './serverDb'
import {
  LAUNCHD_LABEL,
  assertStoreFree,
  envStoreDir,
  launchdPlist,
  systemdUnit,
} from './serverService'

describe('systemdUnit', () => {
  it('always restarts the launcher from home', () => {
    const unit = systemdUnit({
      node: '/usr/bin/node',
      launcher: '/home/u/.lighter-strategies-server/launcher.mjs',
      home: '/home/u/.lighter-strategies-server',
    })
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('StartLimitIntervalSec=0')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/u/.lighter-strategies-server/launcher.mjs"',
    )
    expect(unit).toContain(
      'Environment="STRATEGIES_SERVER_HOME=/home/u/.lighter-strategies-server"',
    )
    expect(unit).toContain('WorkingDirectory=/home/u/.lighter-strategies-server')
    expect(unit).toContain('Environment="STRATEGIES_SERVER_SERVICE=1"')
  })

  it('escapes quotes, backslashes and specifiers in paths', () => {
    const unit = systemdUnit({ node: '/opt/n"o\\de', launcher: '/a/l.mjs', home: '/h/100%' })
    expect(unit).toContain('ExecStart="/opt/n\\"o\\\\de" "/a/l.mjs"')
    expect(unit).toContain('WorkingDirectory=/h/100%%')
    expect(unit).toContain('Environment="STRATEGIES_SERVER_HOME=/h/100%%"')
  })
})

describe('launchdPlist', () => {
  it('keeps the launcher alive and logs into home', () => {
    const plist = launchdPlist({
      node: '/usr/local/bin/node',
      launcher: '/Users/u/.lighter-strategies-server/launcher.mjs',
      home: '/Users/u/.lighter-strategies-server',
    })
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>STRATEGIES_SERVER_SERVICE<\/key>\s*<string>1<\/string>/)
    expect(plist).toMatch(
      /<array>\s*<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/Users\/u\/\.lighter-strategies-server\/launcher\.mjs<\/string>\s*<\/array>/,
    )
    expect(plist).toMatch(
      /<key>StandardOutPath<\/key>\s*<string>\/Users\/u\/\.lighter-strategies-server\/launcher\.log<\/string>/,
    )
    expect(plist).toMatch(
      /<key>StandardErrorPath<\/key>\s*<string>\/Users\/u\/\.lighter-strategies-server\/launcher\.log<\/string>/,
    )
  })

  it('escapes XML in paths', () => {
    const plist = launchdPlist({ node: '/n', launcher: '/a&b/<l>.mjs', home: '/h' })
    expect(plist).toContain('<string>/a&amp;b/&lt;l&gt;.mjs</string>')
  })
})

describe.skipIf(!process.getBuiltinModule?.('node:sqlite'))('assertStoreFree', () => {
  it('refuses a store another server holds, and leaves a free one free', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strategies-service-'))
    try {
      const running = openServerDb(dir)
      expect(() => assertStoreFree(dir)).toThrow(
        /^Another strategies server holds .*: stop the running server first$/,
      )
      running.release()

      assertStoreFree(dir)
      openServerDb(dir).release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('envStoreDir', () => {
  it('resolves the store against home, defaulting to its store dir', async () => {
    const home = await mkdtemp(join(tmpdir(), 'strategies-home-'))
    try {
      const envFile = join(home, '.env')
      await writeFile(envFile, 'STRATEGIES_STORE_DIR=data\n')
      expect(envStoreDir(home, envFile)).toBe(join(home, 'data'))

      await writeFile(envFile, 'STRATEGIES_STORE_DIR=/srv/store\n')
      expect(envStoreDir(home, envFile)).toBe('/srv/store')

      await writeFile(envFile, 'LIGHTER_ENV=testnet\n')
      expect(envStoreDir(home, envFile)).toBe(join(home, 'store'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
