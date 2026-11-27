import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAUNCHER_LOCK_FILE, ServerDbLockedError, lockServerHome, openServerDb } from './serverDb'
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  UNINSTALL_LOCK_RETRY_MS,
  UNINSTALL_LOCK_WAIT_MS,
  installService,
  uninstallService,
} from './serverService'

const state = vi.hoisted(() => ({
  homedir: '',
  calls: [] as string[],
  failing: new Set<string>(),
  released: [] as string[],
  removed: [] as string[],
  onOpenServerDb: (() => {}) as () => void,
  signer: null as { accountIndex: number } | null,
  pendingSigner: null as { accountIndex: number } | null,
  activeState: 'active',
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => state.homedir,
}))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      state.removed.push(String(args[0]))
      fs.rmSync(...args)
    },
  }
})

vi.mock('node:child_process', () => ({
  execFileSync: (command: string, args: string[]) => {
    const call = [command, ...args].join(' ')
    state.calls.push(call)
    if (state.failing.has(call)) throw new Error(`Command failed: ${call}`)
    if (call === `systemctl --user show -p ActiveState --value ${SYSTEMD_UNIT}`) {
      return `${state.activeState}\n`
    }
    return command === 'loginctl' ? 'yes\n' : ''
  },
}))

vi.mock('./serverDb', async (importOriginal) => {
  const fs = await import('node:fs')
  return {
    ...(await importOriginal<typeof import('./serverDb')>()),
    openServerDb: vi.fn((dir: string) => {
      state.calls.push('openServerDb')
      state.onOpenServerDb()
      return {
        readSigner: () => state.signer,
        readPendingSigner: () => state.pendingSigner,
        release: () => state.released.push(`store ${fs.existsSync(dir)}`),
      }
    }),
    lockServerHome: vi.fn((dir: string) => {
      state.calls.push('lockServerHome')
      return () => state.released.push(`home ${fs.existsSync(dir)}`)
    }),
  }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, 'platform', { ...platform, value })

const unitPath = () => join(state.homedir, '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.service`)
const plistPath = () => join(state.homedir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)

let root: string
let home: string
let cwd: string
let launcher: string
let logs: string[]

const install = (envFile = join(cwd, '.env'), allowedAccountIndex: number | null = null) =>
  installService({
    home,
    node: '/usr/bin/node',
    ownLauncher: launcher,
    envFile,
    allowedAccountIndex,
    log: (message) => logs.push(message),
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'strategies-service-'))
  state.homedir = join(root, 'user')
  home = join(root, 'home')
  cwd = join(root, 'cwd')
  for (const dir of [state.homedir, home, cwd]) mkdirSync(dir, { recursive: true })
  launcher = join(cwd, 'launcher.mjs')
  writeFileSync(launcher, '')
  state.calls = []
  state.failing = new Set()
  state.released = []
  state.onOpenServerDb = () => {}
  state.signer = null
  state.pendingSigner = null
  state.activeState = 'active'
  logs = []
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  vi.mocked(openServerDb).mockReset()
  vi.mocked(lockServerHome).mockReset()
  await rm(root, { recursive: true, force: true })
})

describe('installService on Linux', () => {
  beforeEach(() => setPlatform('linux'))

  it('copies .env and the launcher into home and starts the unit', () => {
    writeFileSync(join(cwd, '.env'), 'STRATEGIES_STORE_DIR=/data/store\n')
    install()
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe('STRATEGIES_STORE_DIR=/data/store\n')
    expect(existsSync(join(home, 'launcher.mjs'))).toBe(true)
    expect(readFileSync(unitPath(), 'utf8')).toContain(`ExecStart="/usr/bin/node"`)
    expect(openServerDb).toHaveBeenCalledWith('/data/store')
    expect(state.calls).toEqual(
      expect.arrayContaining([
        `systemctl --user daemon-reload`,
        `systemctl --user enable ${SYSTEMD_UNIT}`,
        `systemctl --user restart ${SYSTEMD_UNIT}`,
      ]),
    )
    expect(logs).toContain('the service runs on the store in /data/store')
  })

  it('stops the installed service before checking the store lock', () => {
    writeFileSync(join(cwd, '.env'), '')
    install()
    expect(state.calls.indexOf(`systemctl --user stop ${SYSTEMD_UNIT}`)).toBeLessThan(
      state.calls.indexOf('openServerDb'),
    )
  })

  it('refuses while another server holds the store, before writing the unit', () => {
    writeFileSync(join(cwd, '.env'), '')
    vi.mocked(openServerDb).mockImplementationOnce(() => {
      throw new ServerDbLockedError('Another strategies server holds the store')
    })
    expect(() => install()).toThrow('stop the running server first')
    expect(existsSync(unitPath())).toBe(false)
  })

  it('keeps home .env when there is none in the current directory', () => {
    writeFileSync(join(home, '.env'), 'STRATEGIES_STORE_DIR=kept\n')
    mkdirSync(join(unitPath(), '..'), { recursive: true })
    writeFileSync(unitPath(), '')
    install()
    expect(openServerDb).toHaveBeenCalledWith(join(home, 'kept'))
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe('STRATEGIES_STORE_DIR=kept\n')
  })

  it('refuses a .env that moves the installed service to another store', () => {
    writeFileSync(join(home, '.env'), 'STRATEGIES_STORE_DIR=/data/old\n')
    writeFileSync(join(cwd, '.env'), 'STRATEGIES_STORE_DIR=/data/new\n')
    mkdirSync(join(unitPath(), '..'), { recursive: true })
    writeFileSync(unitPath(), '')
    expect(() => install()).toThrow('run uninstall-service first')
    expect(state.calls).toEqual([])
    expect(readFileSync(join(home, '.env'), 'utf8')).toBe('STRATEGIES_STORE_DIR=/data/old\n')
  })

  it('accepts a new .env that keeps the installed store', () => {
    writeFileSync(join(home, '.env'), 'STRATEGIES_STORE_DIR=/data/store\n')
    writeFileSync(
      join(cwd, '.env'),
      'STRATEGIES_STORE_DIR=/data/store\nSTRATEGIES_WS_HOST=0.0.0.0\n',
    )
    mkdirSync(join(unitPath(), '..'), { recursive: true })
    writeFileSync(unitPath(), '')
    install()
    expect(readFileSync(join(home, '.env'), 'utf8')).toContain('STRATEGIES_WS_HOST=0.0.0.0')
  })

  it('refuses a .env whose store is home, before touching the service', () => {
    writeFileSync(join(cwd, '.env'), 'STRATEGIES_STORE_DIR=.\n')
    expect(() => install()).toThrow('set it to a directory of its own')
    expect(state.calls).toEqual([])
    expect(existsSync(unitPath())).toBe(false)
  })

  it('refuses a .env whose store is the directory that holds it, before touching the service', () => {
    writeFileSync(join(cwd, '.env'), `STRATEGIES_STORE_DIR=${cwd}\n`)
    expect(() => install()).toThrow(`STRATEGIES_STORE_DIR=${cwd} holds ${cwd}`)
    expect(state.calls).toEqual([])
    expect(existsSync(unitPath())).toBe(false)
  })

  describe('with the store registered to account 678', () => {
    beforeEach(() => {
      state.signer = { accountIndex: 678 }
      writeFileSync(join(home, '.env'), 'OLD=1\n')
      writeFileSync(join(cwd, '.env'), 'NEW=1\n')
    })
    const installed = () => {
      mkdirSync(join(unitPath(), '..'), { recursive: true })
      writeFileSync(unitPath(), 'old unit')
    }

    it('refuses another account and starts the running service again, unchanged', () => {
      installed()
      expect(() => install(undefined, 12345)).toThrow(
        'STRATEGIES_WS_ALLOWED_ACCOUNT_INDEX=12345 but the store is registered to account 678',
      )
      expect(state.calls.slice(-2)).toEqual([
        'openServerDb',
        `systemctl --user start ${SYSTEMD_UNIT}`,
      ])
      expect(state.released).toEqual(['store false'])
      expect(readFileSync(unitPath(), 'utf8')).toBe('old unit')
      expect(readFileSync(join(home, '.env'), 'utf8')).toBe('OLD=1\n')
      expect(existsSync(join(home, 'launcher.mjs'))).toBe(false)
    })

    it('refuses another account than the pending signer', () => {
      state.signer = null
      state.pendingSigner = { accountIndex: 678 }
      expect(() => install(undefined, 12345)).toThrow('registered to account 678')
    })

    it.each(['inactive', 'failed'])('leaves a %s service stopped', (activeState) => {
      installed()
      state.activeState = activeState
      expect(() => install(undefined, 12345)).toThrow('registered to account 678')
      expect(state.calls).not.toContain(`systemctl --user start ${SYSTEMD_UNIT}`)
    })

    it('starts a service waiting to restart again', () => {
      installed()
      state.activeState = 'activating'
      expect(() => install(undefined, 12345)).toThrow('registered to account 678')
      expect(state.calls.at(-1)).toBe(`systemctl --user start ${SYSTEMD_UNIT}`)
    })

    it.each([678, null])('installs with allowed account %s', (allowed) => {
      installed()
      install(undefined, allowed)
      expect(readFileSync(join(home, '.env'), 'utf8')).toBe('NEW=1\n')
      expect(state.calls).toContain(`systemctl --user restart ${SYSTEMD_UNIT}`)
    })
  })

  it('refuses with no .env in the current directory or home', () => {
    expect(() => install()).toThrow('No .env to start the service with')
  })
})

describe('installService on macOS', () => {
  const { uid } = userInfo()
  beforeEach(() => {
    setPlatform('darwin')
    writeFileSync(join(cwd, '.env'), '')
  })

  it('bootstraps into the GUI domain when there is a desktop login', () => {
    install()
    expect(existsSync(plistPath())).toBe(true)
    expect(state.calls).toContain(`launchctl bootstrap gui/${uid} ${plistPath()}`)
  })

  it('falls back to the user domain without a desktop login, and says so', () => {
    state.failing.add(`launchctl print gui/${uid}`)
    install()
    expect(state.calls).toContain(`launchctl bootstrap user/${uid} ${plistPath()}`)
    expect(logs.some((message) => message.startsWith('No desktop login'))).toBe(true)
  })

  describe('with the store registered to account 678', () => {
    beforeEach(() => {
      state.signer = { accountIndex: 678 }
      mkdirSync(join(plistPath(), '..'), { recursive: true })
      writeFileSync(plistPath(), 'old plist')
    })

    it('bootstraps the old plist again into the domain it was loaded in', () => {
      state.failing.add(`launchctl print gui/${uid}/${LAUNCHD_LABEL}`)
      expect(() => install(undefined, 12345)).toThrow('registered to account 678')
      expect(state.calls.at(-1)).toBe(`launchctl bootstrap user/${uid} ${plistPath()}`)
      expect(readFileSync(plistPath(), 'utf8')).toBe('old plist')
    })

    it('leaves a service that was not loaded stopped', () => {
      for (const domain of [`gui/${uid}`, `user/${uid}`]) {
        state.failing.add(`launchctl print ${domain}/${LAUNCHD_LABEL}`)
      }
      expect(() => install(undefined, 12345)).toThrow('registered to account 678')
      expect(state.calls.some((call) => call.startsWith('launchctl bootstrap'))).toBe(false)
    })
  })

  it('boots out both domains before checking the store lock', () => {
    install()
    const lockCheck = state.calls.indexOf('openServerDb')
    for (const domain of [`gui/${uid}`, `user/${uid}`]) {
      expect(state.calls.indexOf(`launchctl bootout ${domain}/${LAUNCHD_LABEL}`)).toBeLessThan(
        lockCheck,
      )
    }
  })
})

describe('uninstallService', () => {
  const sleep = vi.fn((_ms: number) => {})
  const uninstall = () => uninstallService({ home, log: (message) => logs.push(message), sleep })
  const makeStore = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'server.lock.db'), 'seed')
  }
  const writeStatuses = (dir: string, statuses: string[]) =>
    writeFileSync(
      join(dir, 'lighter-strategies-v1.json'),
      JSON.stringify({
        state: {
          strategies: Object.fromEntries(
            statuses.map((status, i) => [`s${i}`, { progress: { status } }]),
          ),
        },
      }),
    )
  const locked = () => {
    throw new ServerDbLockedError('Another strategies server holds the lock')
  }
  const ATTEMPTS = UNINSTALL_LOCK_WAIT_MS / UNINSTALL_LOCK_RETRY_MS + 1

  beforeEach(() => {
    writeFileSync(join(home, LAUNCHER_LOCK_FILE), '')
    sleep.mockClear()
  })

  it('disables and removes the unit on Linux, then deletes home and the store in it', () => {
    setPlatform('linux')
    mkdirSync(join(unitPath(), '..'), { recursive: true })
    writeFileSync(unitPath(), '')
    writeFileSync(join(home, '.env'), '')
    makeStore(join(home, 'store'))
    mkdirSync(join(home, 'versions', '1.0.0'), { recursive: true })
    uninstall()
    expect(state.calls).toContain(`systemctl --user disable --now ${SYSTEMD_UNIT}`)
    expect(state.calls.indexOf(`systemctl --user disable --now ${SYSTEMD_UNIT}`)).toBeLessThan(
      state.calls.indexOf('openServerDb'),
    )
    expect(openServerDb).toHaveBeenCalledWith(join(home, 'store'))
    expect(lockServerHome).toHaveBeenCalledWith(home)
    expect(existsSync(unitPath())).toBe(false)
    expect(existsSync(home)).toBe(false)
  })

  it('keeps the TLS certificate in home and deletes everything else', () => {
    setPlatform('linux')
    writeFileSync(join(home, '.env'), '')
    makeStore(join(home, 'store'))
    mkdirSync(join(home, 'versions', '1.0.0'), { recursive: true })
    mkdirSync(join(home, 'tls'))
    writeFileSync(join(home, 'tls', 'cert.pem'), 'cert')
    uninstall()
    expect(readdirSync(home)).toEqual(['tls'])
    expect(readFileSync(join(home, 'tls', 'cert.pem'), 'utf8')).toBe('cert')
    expect(logs).toContain(`deleted ${home}, keeping the TLS certificate in ${join(home, 'tls')}`)
  })

  it('boots out both domains and removes the plist on macOS, then deletes home', () => {
    setPlatform('darwin')
    const { uid } = userInfo()
    mkdirSync(join(plistPath(), '..'), { recursive: true })
    writeFileSync(plistPath(), '')
    uninstall()
    expect(state.calls).toEqual([
      `launchctl bootout gui/${uid}/${LAUNCHD_LABEL}`,
      `launchctl bootout user/${uid}/${LAUNCHD_LABEL}`,
      'lockServerHome',
    ])
    expect(existsSync(plistPath())).toBe(false)
    expect(existsSync(home)).toBe(false)
  })

  it('says there is no store, without creating one, when the store dir is missing', () => {
    setPlatform('linux')
    uninstall()
    expect(openServerDb).not.toHaveBeenCalled()
    expect(logs).toContain(`no store in ${join(home, 'store')}`)
    expect(logs).not.toContain(`deleted the store in ${join(home, 'store')}`)
    expect(existsSync(home)).toBe(false)
  })

  it('keeps the service and the store while a strategy is running', () => {
    setPlatform('linux')
    mkdirSync(join(unitPath(), '..'), { recursive: true })
    writeFileSync(unitPath(), '')
    makeStore(join(home, 'store'))
    writeStatuses(join(home, 'store'), ['completed', 'running', 'running'])
    expect(() => uninstall()).toThrow(
      `2 strategies are still running in ${join(home, 'store')}: stop them first`,
    )
    expect(state.calls).toEqual([])
    expect(existsSync(unitPath())).toBe(true)
    expect(existsSync(join(home, 'store', 'server.lock.db'))).toBe(true)
  })

  it('deletes the service and a store with running strategies when told to, and says so', () => {
    setPlatform('linux')
    mkdirSync(join(unitPath(), '..'), { recursive: true })
    writeFileSync(unitPath(), '')
    makeStore(join(home, 'store'))
    writeStatuses(join(home, 'store'), ['running', 'running', 'aborted'])
    uninstallService({
      home,
      log: (message) => logs.push(message),
      deleteRunningStrategies: true,
      sleep,
    })
    expect(existsSync(unitPath())).toBe(false)
    expect(existsSync(home)).toBe(false)
    expect(logs).toContain(
      `2 strategies are still running in ${join(home, 'store')}, deleting the store anyway: their resting orders stay on the book until you cancel them`,
    )
  })

  it('deletes an unreadable store when told to', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    writeFileSync(join(home, 'store', 'lighter-strategies-v1.json'), '{')
    expect(() => uninstall()).toThrow('--delete-running-strategies to delete the store anyway')
    uninstallService({
      home,
      log: (message) => logs.push(message),
      deleteRunningStrategies: true,
      sleep,
    })
    expect(existsSync(home)).toBe(false)
    expect(logs).toContain(
      `cannot read the strategies in ${join(home, 'store')}, deleting the store anyway: cancel any order its strategies left on the book`,
    )
  })

  it('deletes home when an older install made it the store', () => {
    setPlatform('linux')
    writeFileSync(join(home, '.env'), 'STRATEGIES_STORE_DIR=.\n')
    writeFileSync(join(home, 'server.lock.db'), 'seed')
    uninstall()
    expect(existsSync(home)).toBe(false)
    expect(logs).toContain(`deleted ${home}`)
  })

  it('holds the store and home locks until both are deleted', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    uninstall()
    expect(state.released).toEqual(['home false', 'store false'])
  })

  it('deletes the launcher lock after everything else in home', () => {
    setPlatform('linux')
    writeFileSync(join(home, '.env'), '')
    mkdirSync(join(home, 'versions', '1.0.0'), { recursive: true })
    mkdirSync(join(home, 'logs'))
    state.removed = []
    uninstall()
    const inHome = state.removed.filter((path) => dirname(path) === home)
    expect(inHome.slice(-2)).toEqual([
      join(home, LAUNCHER_LOCK_FILE),
      join(home, `${LAUNCHER_LOCK_FILE}-journal`),
    ])
    expect(existsSync(home)).toBe(false)
  })

  it('releases the store lock when it refuses', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    state.onOpenServerDb = () => writeStatuses(join(home, 'store'), ['running'])
    expect(() => uninstall()).toThrow('the service is already removed')
    expect(state.released).toEqual(['store true'])
  })

  it('deletes a store whose strategies are all completed or aborted', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    writeStatuses(join(home, 'store'), ['completed', 'aborted'])
    uninstall()
    expect(existsSync(home)).toBe(false)
  })

  it('keeps the store when a strategy started before the service stopped', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    state.onOpenServerDb = () => writeStatuses(join(home, 'store'), ['running'])
    expect(() => uninstall()).toThrow(
      `1 strategy is still running in ${join(home, 'store')}, and the service is already removed: run install-service again to stop it from a frontend, then uninstall-service`,
    )
    expect(lockServerHome).not.toHaveBeenCalled()
    expect(existsSync(join(home, 'store', 'server.lock.db'))).toBe(true)
  })

  it('waits for the stopped service to release the store and home', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    vi.mocked(openServerDb).mockImplementationOnce(locked).mockImplementationOnce(locked)
    vi.mocked(lockServerHome).mockImplementationOnce(locked)
    uninstall()
    expect(openServerDb).toHaveBeenCalledTimes(3)
    expect(lockServerHome).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls).toEqual(Array(3).fill([UNINSTALL_LOCK_RETRY_MS]))
    expect(existsSync(home)).toBe(false)
  })

  it('keeps home and a store in it that the home .env does not name', () => {
    setPlatform('linux')
    const live = join(home, 'live')
    makeStore(live)
    writeStatuses(live, ['running'])
    writeFileSync(join(home, '.env'), '')
    writeFileSync(join(home, 'launcher.mjs'), '')
    mkdirSync(join(home, 'versions', '1.0.0'), { recursive: true })
    mkdirSync(join(home, 'logs'))
    uninstall()
    expect(readdirSync(home)).toEqual(['live'])
    expect(existsSync(join(live, 'server.lock.db'))).toBe(true)
    expect(logs).toContain(`kept ${home}, which still holds live`)
  })

  it('deletes the store the home .env points outside home', () => {
    setPlatform('linux')
    const storeDir = join(root, 'data', 'store')
    makeStore(storeDir)
    writeFileSync(join(home, '.env'), `STRATEGIES_STORE_DIR=${storeDir}\n`)
    uninstall()
    expect(openServerDb).toHaveBeenCalledWith(storeDir)
    expect(existsSync(storeDir)).toBe(false)
    expect(existsSync(home)).toBe(false)
  })

  it('keeps a dir outside home that holds no store, without opening a store in it', () => {
    setPlatform('linux')
    const dir = join(root, 'projects')
    mkdirSync(dir)
    writeFileSync(join(dir, 'notes.txt'), '')
    writeFileSync(join(home, '.env'), `STRATEGIES_STORE_DIR=${dir}\n`)
    uninstall()
    expect(openServerDb).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(logs).toContain(`kept ${dir}, which holds no strategies server store`)
    expect(existsSync(home)).toBe(false)
  })

  it('keeps a home no server ran from, and the store dir inside it, without locking it', () => {
    setPlatform('linux')
    rmSync(join(home, LAUNCHER_LOCK_FILE))
    writeFileSync(join(home, 'notes.txt'), '')
    mkdirSync(join(home, 'store'))
    writeFileSync(join(home, 'store', 'notes.txt'), '')
    uninstall()
    expect(lockServerHome).not.toHaveBeenCalled()
    expect(existsSync(join(home, 'notes.txt'))).toBe(true)
    expect(existsSync(join(home, 'store', 'notes.txt'))).toBe(true)
    expect(existsSync(join(home, LAUNCHER_LOCK_FILE))).toBe(false)
    expect(logs).toContain(`kept ${home}, which holds no strategies server`)
  })

  it.each([
    ['home is the user home', () => state.homedir, () => ''],
    ['the store holds the user home', () => home, () => `STRATEGIES_STORE_DIR=${root}\n`],
  ])('deletes nothing and keeps the service when %s', (_, homeDir, env) => {
    setPlatform('linux')
    home = homeDir()
    writeFileSync(join(home, '.env'), env())
    expect(() => uninstall()).toThrow('holds your home directory')
    expect(state.calls).toEqual([])
    expect(existsSync(join(home, '.env'))).toBe(true)
  })

  it('keeps home while another server holds the store for 15 s', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    for (let i = 0; i < ATTEMPTS; i++) vi.mocked(openServerDb).mockImplementationOnce(locked)
    expect(() => uninstall()).toThrow('stop the running server first')
    expect(openServerDb).toHaveBeenCalledTimes(ATTEMPTS)
    expect(sleep).toHaveBeenCalledTimes(ATTEMPTS - 1)
    expect(existsSync(join(home, 'store', 'server.lock.db'))).toBe(true)
  })

  it('keeps home while a launcher runs from it for 15 s', () => {
    setPlatform('linux')
    makeStore(join(home, 'store'))
    for (let i = 0; i < ATTEMPTS; i++) vi.mocked(lockServerHome).mockImplementationOnce(locked)
    expect(() => uninstall()).toThrow(`A strategies server runs from ${home}: stop it first`)
    expect(lockServerHome).toHaveBeenCalledTimes(ATTEMPTS)
    expect(existsSync(join(home, 'store', 'server.lock.db'))).toBe(true)
  })
})
