import { type KeyObject, X509Certificate, createPrivateKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { join } from 'node:path'
import {
  LETS_ENCRYPT_DIRECTORY,
  LETS_ENCRYPT_TERMS_URL,
  generateCertificateKey,
  issueIpCertificate,
} from './serverAcme'
import { readEnv, readIntEnv, readUrlEnv } from './serverEnv'

/** Answers with the caller's public IPv4 as plain text. */
export const PUBLIC_IP_URL = 'https://checkip.amazonaws.com'
const PUBLIC_IP_TIMEOUT_MS = 10_000
export const TLS_DIR = 'tls'
const ACCOUNT_KEY_FILE = 'account.key.pem'
const KEY_FILE = 'key.pem'
const CERT_FILE = 'cert.pem'
const DIRECTORY_FILE = 'directory.txt'
/** How often the server checks whether its certificate is due for renewal. */
export const TLS_RENEWAL_CHECK_MS = 60 * 60 * 1000

// Let's Encrypt cannot reach these, so it never issues a certificate for them.
const isNonPublicIpv4 = (ip: string): boolean => {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

export const assertPublicIpv4 = (ip: string): string => {
  if (!isIPv4(ip)) throw new Error(`${ip} is not an IPv4 address`)
  if (isNonPublicIpv4(ip)) {
    throw new Error(`${ip} is not a public IPv4 address, Let's Encrypt cannot reach it`)
  }
  return ip
}

export const fetchPublicIp = async (fetchFn: typeof fetch = fetch): Promise<string> => {
  const response = await fetchFn(PUBLIC_IP_URL, {
    signal: AbortSignal.timeout(PUBLIC_IP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${PUBLIC_IP_URL} answered ${response.status}`)
  return (await response.text()).trim()
}

/** The IP STRATEGIES_TLS_IP names, `auto` being the one PUBLIC_IP_URL sees. */
export const resolveTlsIp = async (value: string, fetchFn?: typeof fetch): Promise<string> =>
  assertPublicIpv4(value === 'auto' ? await fetchPublicIp(fetchFn) : value)

export interface TlsCertificate {
  cert: string
  key: string
}

/** Renewed past half its lifetime, as Let's Encrypt advises for 6-day certificates. */
export const isDueForRenewal = (cert: string, ip: string, now: number): boolean => {
  const x509 = new X509Certificate(cert)
  if (!x509.checkIP(ip)) return true
  const from = Date.parse(x509.validFrom)
  const to = Date.parse(x509.validTo)
  return now >= from + (to - from) / 2
}

// Every file is written before any is renamed, so a failed write leaves the previous set.
const writePrivate = (...files: [path: string, content: string][]) => {
  for (const [path, content] of files) writeFileSync(`${path}.tmp`, content, { mode: 0o600 })
  for (const [path] of files) renameSync(`${path}.tmp`, path)
}

const readKey = (path: string): KeyObject | null =>
  existsSync(path) ? createPrivateKey(readFileSync(path, 'utf8')) : null

export const readTlsCertificate = (home: string): TlsCertificate | null => {
  const dir = join(home, TLS_DIR)
  if (!existsSync(join(dir, CERT_FILE)) || !existsSync(join(dir, KEY_FILE))) return null
  return {
    cert: readFileSync(join(dir, CERT_FILE), 'utf8'),
    key: readFileSync(join(dir, KEY_FILE), 'utf8'),
  }
}

const isPair = ({ cert, key }: TlsCertificate) => {
  try {
    return new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))
  } catch {
    return false
  }
}

const readIssuingDirectory = (home: string): string | null => {
  const path = join(home, TLS_DIR, DIRECTORY_FILE)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** The certificate on disk, unless it has expired, another directory issued it, or a renewal stopped between renaming the key and the certificate. */
export const readServableTlsCertificate = (
  home: string,
  directoryUrl: string,
  now: number,
): TlsCertificate | null => {
  const current = readTlsCertificate(home)
  if (!current || !isPair(current) || readIssuingDirectory(home) !== directoryUrl) return null
  return now < Date.parse(new X509Certificate(current.cert).validTo) ? current : null
}

export interface EnsureTlsCertificateOptions {
  home: string
  ip: string
  directoryUrl: string
  httpPort: number
  log: (message: string) => void
  now?: number
  fetchFn?: typeof fetch
}

/** The certificate in `<home>/tls` for `ip`, first issued or renewed when it is missing, for another IP, from another directory or past half its life; null when nothing changed. */
export const ensureTlsCertificate = async ({
  home,
  ip,
  directoryUrl,
  httpPort,
  log,
  now = Date.now(),
  fetchFn,
}: EnsureTlsCertificateOptions): Promise<TlsCertificate | null> => {
  const current = readTlsCertificate(home)
  if (
    current &&
    isPair(current) &&
    readIssuingDirectory(home) === directoryUrl &&
    !isDueForRenewal(current.cert, ip, now)
  ) {
    return null
  }
  const dir = join(home, TLS_DIR)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const accountKeyPath = join(dir, ACCOUNT_KEY_FILE)
  let accountKey = readKey(accountKeyPath)
  if (!accountKey) {
    log(
      `Creating a Let's Encrypt account for the certificate, which accepts the Let's Encrypt Subscriber Agreement: ${LETS_ENCRYPT_TERMS_URL}`,
    )
    accountKey = generateCertificateKey()
    writePrivate([accountKeyPath, accountKey.export({ type: 'pkcs8', format: 'pem' }).toString()])
  }
  const certificateKey = generateCertificateKey()
  log(`${current ? 'renewing' : 'requesting'} the TLS certificate for ${ip} from ${directoryUrl}`)
  const cert = await issueIpCertificate({
    ip,
    directoryUrl,
    accountKey,
    certificateKey,
    httpPort,
    log,
    fetchFn,
  })
  const key = certificateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  writePrivate(
    [join(dir, KEY_FILE), key],
    [join(dir, CERT_FILE), cert],
    [join(dir, DIRECTORY_FILE), directoryUrl],
  )
  log(`TLS certificate for ${ip} valid until ${new X509Certificate(cert).validTo}`)
  return { cert, key }
}

export interface TlsSettings {
  ip: string
  directoryUrl: string
  httpPort: number
}

/** The TLS config of the env, null when STRATEGIES_TLS_IP is unset and the websocket stays plain ws://. */
export const readTlsSettings = async (fetchFn?: typeof fetch): Promise<TlsSettings | null> => {
  const value = readEnv('STRATEGIES_TLS_IP')
  if (value === undefined) return null
  return {
    ip: await resolveTlsIp(value, fetchFn),
    directoryUrl: readUrlEnv('STRATEGIES_ACME_DIRECTORY', ['https:'], LETS_ENCRYPT_DIRECTORY),
    httpPort: readIntEnv('STRATEGIES_ACME_HTTP_PORT', 1, 65535, 80),
  }
}
