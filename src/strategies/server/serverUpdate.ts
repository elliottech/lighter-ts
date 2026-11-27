import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SERVER_ENTRY, versionDir, versionsDir, writeCurrentVersion } from './serverHome'

/** The npm registry and package the server's versions are published in. */
export interface ServerRegistry {
  url: string
  packageName: string
}

const SERVER_DIR = 'package/dist/strategies-server'

export interface UpdatePolicy {
  allowPrerelease: boolean
  allowDowngrade: boolean
}

const parseVersion = (version: string) => {
  const dash = version.indexOf('-')
  const core = (dash === -1 ? version : version.slice(0, dash)).split('.').map(Number)
  return { core, isPrerelease: dash !== -1 }
}

const compareCores = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Why a server running `current` refuses to update to `target`, null when it
 * may. A pre-release server may go anywhere; a release server only to a newer
 * release, unless the policy allows pre-releases or downgrades. Pre-releases
 * are numbered by PR, not by age, so they are not compared.
 */
export const refuseUpdate = (
  current: string,
  target: string,
  { allowPrerelease, allowDowngrade }: UpdatePolicy,
): string | null => {
  const from = parseVersion(current)
  const to = parseVersion(target)
  if (from.isPrerelease) return null
  if (to.isPrerelease) {
    return allowPrerelease
      ? null
      : `${target} is a pre-release, which this server only installs with STRATEGIES_ALLOW_PRERELEASE_UPDATES=true`
  }
  if (!allowDowngrade && compareCores(to.core, from.core) < 0) {
    return `${target} is older than the running ${current}, which this server only installs with STRATEGIES_ALLOW_DOWNGRADE=true`
  }
  return null
}

type Packument = {
  versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } } | undefined>
}

const extractTarball = async (tarball: string, dir: string): Promise<void> => {
  await promisify(execFile)('tar', [
    '-xzf',
    tarball,
    '-C',
    dir,
    '--no-same-owner',
    'package/package.json',
    SERVER_DIR,
  ])
}

const checkIntegrity = (data: Buffer, integrity: unknown): void => {
  const expected =
    typeof integrity === 'string'
      ? integrity.split(/\s+/).find((entry) => entry.startsWith('sha512-'))
      : undefined
  if (!expected) throw new Error('The registry gave no sha512 integrity for the tarball')
  const actual = `sha512-${createHash('sha512').update(data).digest('base64')}`
  if (actual !== expected) throw new Error('The tarball does not match its integrity')
}

export interface InstallServerVersionOptions {
  home: string
  version: string
  registry: ServerRegistry
  fetch?: typeof fetch
  extract?: (tarball: string, dir: string) => Promise<void>
}

/**
 * Downloads `version` of the registry's package, checks it against the
 * registry's integrity, unpacks its `dist/strategies-server` into the home's
 * versions and makes it the version the launcher runs.
 */
export const installServerVersion = async ({
  home,
  version,
  registry,
  fetch: fetchUrl = fetch,
  extract = extractTarball,
}: InstallServerVersionOptions): Promise<void> => {
  const base = new URL(registry.url.endsWith('/') ? registry.url : `${registry.url}/`)
  const get = async (url: URL, accept: string) => {
    if (url.origin !== base.origin) throw new Error(`${url} is not on the registry`)
    const response = await fetchUrl(url, { headers: { Accept: accept } })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response
  }

  const packumentUrl = new URL(registry.packageName.replace('/', '%2f'), base)
  const packument = (await (
    await get(packumentUrl, 'application/vnd.npm.install-v1+json')
  ).json()) as Packument
  const dist = packument.versions?.[version]?.dist
  if (!dist) throw new Error(`${registry.packageName}@${version} is not in the registry`)
  if (typeof dist.tarball !== 'string') {
    throw new Error(`${registry.packageName}@${version} has no tarball`)
  }
  const data = Buffer.from(
    await (await get(new URL(dist.tarball), 'application/octet-stream')).arrayBuffer(),
  )
  checkIntegrity(data, dist.integrity)

  await mkdir(versionsDir(home), { recursive: true })
  const staging = join(versionsDir(home), `.${version}.${randomUUID()}`)
  try {
    await mkdir(staging)
    const tarball = join(staging, 'package.tgz')
    await writeFile(tarball, data)
    await extract(tarball, staging)
    const manifest = JSON.parse(
      await readFile(join(staging, 'package', 'package.json'), 'utf8'),
    ) as { name?: unknown; version?: unknown }
    if (manifest.name !== registry.packageName || manifest.version !== version) {
      throw new Error(`The tarball holds ${String(manifest.name)}@${String(manifest.version)}`)
    }
    const serverDir = join(staging, SERVER_DIR)
    if (!existsSync(join(serverDir, SERVER_ENTRY))) {
      throw new Error(`${registry.packageName}@${version} has no strategies server`)
    }
    const target = versionDir(home, version)
    await rm(target, { recursive: true, force: true })
    await rename(serverDir, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  writeCurrentVersion(home, version)
}
