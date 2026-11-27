import { type ChildProcess, fork, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openServerDb } from './serverDb'

const hasSqlite = Boolean(process.getBuiltinModule?.('node:sqlite'))

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'strategies-bundle-'))
  await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    outdir: join(root, 'out'),
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
    // As in build-strategies-server.mjs.
    alias: {
      '@formatjs/intl-pluralrules/locale-data/en': '@formatjs/intl-pluralrules/locale-data/en.js',
      '@formatjs/intl-numberformat/locale-data/en': '@formatjs/intl-numberformat/locale-data/en.js',
    },
    entryPoints: [
      join(import.meta.dirname, 'server.main.ts'),
      join(import.meta.dirname, 'launcher.ts'),
    ],
    banner: {
      js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
    },
  })
}, 30_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(address),
      )
    })
  })

const exitOf = (child: ChildProcess, ms: number) =>
  new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still running after ${ms}ms`)), ms)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

describe.skipIf(!hasSqlite)('the server', () => {
  it('exits and releases the store once its launcher is gone', async () => {
    const storeDir = join(root, 'store')
    const child = fork(join(root, 'out', 'server.main.mjs'), [], {
      execArgv: ['--disable-warning=ExperimentalWarning'],
      env: {
        ...process.env,
        STRATEGIES_STORE_DIR: storeDir,
        STRATEGIES_WS_PORT: String(await freePort()),
        LIGHTER_CHAIN_ID: '300',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('exit', (code) => reject(new Error(`exited with ${code} before it was ready`)))
        child.on('message', (message) => {
          if ((message as { kind?: string }).kind === 'ready') resolve()
        })
      })
      child.disconnect()
      expect(await exitOf(child, 5_000)).toBe(1)
      openServerDb(storeDir).release()
    } finally {
      child.kill('SIGKILL')
    }
  }, 15_000)
})

describe('the launcher', () => {
  it('refuses an unknown command', () => {
    const result = spawnSync(process.execPath, [join(root, 'out', 'launcher.mjs'), 'bogus'], {
      env: { ...process.env, STRATEGIES_SERVER_HOME: join(root, 'home') },
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'unknown command bogus, expected install-service or uninstall-service',
    )
  })

  it('reinstalls with the .env in home when there is none here', async () => {
    const home = join(root, 'reinstall-home')
    const cwd = join(root, 'reinstall-cwd')
    await mkdir(home)
    await mkdir(cwd)
    await writeFile(join(home, '.env'), 'STRATEGIES_TLS_IP=8.8.8.8\n')

    const result = spawnSync(
      process.execPath,
      [join(root, 'out', 'launcher.mjs'), 'install-service'],
      {
        cwd,
        env: { ...process.env, HOME: join(root, 'reinstall-user'), STRATEGIES_SERVER_HOME: home },
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'STRATEGIES_WS_ALLOWED_ACCOUNT_INDEX is required with STRATEGIES_TLS_IP',
    )
  })
})
