import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCurrentVersion, versionDir, versionsDir } from './serverHome'
import {
  type ServerRegistry,
  type UpdatePolicy,
  installServerVersion,
  refuseUpdate,
} from './serverUpdate'

const REGISTRY: ServerRegistry = {
  url: 'https://registry.test',
  packageName: 'lighter-ts',
}
const VERSION = '1.0.1'
const TARBALL = 'https://registry.test/lighter-ts/-/lighter-ts-1.0.1.tgz'
const DATA = Buffer.from('tarball')
const INTEGRITY = `sha512-${createHash('sha512').update(DATA).digest('base64')}`

type Contents = { name?: string; version?: string; entry?: boolean }

// Writes what `tar` would unpack from a package with these contents.
const extractAs =
  ({ name = REGISTRY.packageName, version = VERSION, entry = true }: Contents = {}) =>
  async (tarball: string, dir: string) => {
    expect(readFileSync(tarball)).toEqual(DATA)
    const serverDir = join(dir, 'package', 'dist', 'strategies-server')
    await mkdir(serverDir, { recursive: true })
    await writeFile(join(dir, 'package', 'package.json'), JSON.stringify({ name, version }))
    if (entry) await writeFile(join(serverDir, 'server.main.mjs'), 'export {}')
  }

const registryFetch = (dist: { tarball?: string; integrity?: string } = {}) =>
  vi.fn((url: URL | RequestInfo) => {
    const href = url instanceof URL ? url.href : typeof url === 'string' ? url : url.url
    if (href === 'https://registry.test/lighter-ts') {
      return Promise.resolve(
        Response.json({
          versions: { [VERSION]: { dist: { tarball: TARBALL, integrity: INTEGRITY, ...dist } } },
        }),
      )
    }
    if (href === (dist.tarball ?? TARBALL)) return Promise.resolve(new Response(DATA))
    return Promise.resolve(new Response(null, { status: 404 }))
  })

describe('installServerVersion', () => {
  const homes: string[] = []
  const makeHome = () => {
    const home = mkdtempSync(join(tmpdir(), 'strategies-server-home-'))
    homes.push(home)
    return home
  }
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('unpacks the version and makes it current', async () => {
    const home = makeHome()
    const fetch = registryFetch()
    await installServerVersion({
      home,
      version: VERSION,
      registry: REGISTRY,
      fetch,
      extract: extractAs(),
    })

    expect(existsSync(join(versionDir(home, VERSION), 'server.main.mjs'))).toBe(true)
    expect(readCurrentVersion(home)).toBe(VERSION)
    expect(await readdir(versionsDir(home))).toEqual([VERSION])
    for (const [, init] of fetch.mock.calls as unknown as [URL, RequestInit][]) {
      expect(init.headers).not.toHaveProperty('Authorization')
    }
  })

  it.each<[string, Parameters<typeof registryFetch>[0], Contents, string, string?]>([
    ['is not in the registry', {}, {}, 'is not in the registry', '9.9.9'],
    [
      'tarball is on another host',
      { tarball: 'https://evil.test/x.tgz' },
      {},
      'is not on the registry',
    ],
    [
      'tarball does not match its integrity',
      { integrity: 'sha512-AAAA' },
      {},
      'does not match its integrity',
    ],
    ['registry gives no sha512 integrity', { integrity: 'sha1-AAAA' }, {}, 'no sha512 integrity'],
    [
      'tarball holds another package',
      {},
      { name: '@evil/pkg' },
      'The tarball holds @evil/pkg@1.0.1',
    ],
    ['tarball holds another version', {}, { version: '1.0.2' }, 'The tarball holds'],
    ['package has no server', {}, { entry: false }, 'has no strategies server'],
  ])(
    'leaves the current version alone when the %s',
    async (_, dist, contents, error, version = VERSION) => {
      const home = makeHome()
      await expect(
        installServerVersion({
          home,
          version,
          registry: REGISTRY,
          fetch: registryFetch(dist),
          extract: extractAs(contents),
        }),
      ).rejects.toThrow(error)
      expect(readCurrentVersion(home)).toBeNull()
      expect(existsSync(versionsDir(home)) ? await readdir(versionsDir(home)) : []).toEqual([])
    },
  )
})

describe('refuseUpdate', () => {
  const STRICT: UpdatePolicy = { allowPrerelease: false, allowDowngrade: false }
  const PRERELEASE = '0.1528.0-author.abc123.strategies-server'

  it.each([
    ['a newer patch', '1.0.48', '1.0.49'],
    ['a newer minor', '1.0.48', '1.1.0'],
    ['a newer major', '1.9.9', '2.0.0'],
    ['a release, from a pre-release', PRERELEASE, '1.0.1'],
    ['another pre-release, from a pre-release', PRERELEASE, '0.1600.0-a.b.c'],
  ])('allows %s', (_, current, target) => {
    expect(refuseUpdate(current, target, STRICT)).toBeNull()
  })

  it.each([
    ['an older patch', '1.0.48', '1.0.47'],
    ['an older minor', '1.2.0', '1.1.99'],
    ['an older major', '2.0.0', '1.99.99'],
    ['a numerically older patch', '1.0.10', '1.0.9'],
  ])('refuses %s unless downgrades are allowed', (_, current, target) => {
    expect(refuseUpdate(current, target, STRICT)).toBe(
      `${target} is older than the running ${current}, which this server only installs with STRATEGIES_ALLOW_DOWNGRADE=true`,
    )
    expect(refuseUpdate(current, target, { ...STRICT, allowDowngrade: true })).toBeNull()
  })

  it('refuses a pre-release on a release server unless pre-releases are allowed', () => {
    expect(refuseUpdate('1.0.48', PRERELEASE, STRICT)).toBe(
      `${PRERELEASE} is a pre-release, which this server only installs with STRATEGIES_ALLOW_PRERELEASE_UPDATES=true`,
    )
    expect(refuseUpdate('1.0.48', PRERELEASE, { ...STRICT, allowDowngrade: true })).not.toBeNull()
    expect(refuseUpdate('1.0.48', PRERELEASE, { ...STRICT, allowPrerelease: true })).toBeNull()
  })
})
