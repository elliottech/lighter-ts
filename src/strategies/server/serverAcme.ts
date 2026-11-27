import { type KeyObject, createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { isIPv4 } from 'node:net'

// A minimal RFC 8555 client for the one thing the server needs: a certificate
// for its own IP address, validated over http-01.

export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory'
export const LETS_ENCRYPT_STAGING_DIRECTORY =
  'https://acme-staging-v02.api.letsencrypt.org/directory'
/** Let's Encrypt only issues IP address certificates on this profile, valid for 160 hours. */
export const ACME_SHORTLIVED_PROFILE = 'shortlived'
const POLL_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 30_000
export const LETS_ENCRYPT_TERMS_URL = 'https://letsencrypt.org/repository/'
export const PRIVILEGED_PORTS_HINT =
  'ports below 1024 need privileges on this machine. Allow them once with: echo net.ipv4.ip_unprivileged_port_start=80 | sudo tee /etc/sysctl.d/50-lighter-strategies.conf && sudo sysctl --system'

const base64url = (data: Buffer | string): string => Buffer.from(data).toString('base64url')

const der = (tag: number, content: Buffer): Buffer => {
  const { length } = content
  if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(length)
  const bytes = size.subarray(size.findIndex((byte) => byte !== 0))
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length]), bytes, content])
}
const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items))
const oid = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number)
  const bytes = [first * 40 + second]
  for (const arc of rest) {
    const groups = [arc & 0x7f]
    for (let value = arc >>> 7; value > 0; value >>>= 7) groups.unshift((value & 0x7f) | 0x80)
    bytes.push(...groups)
  }
  return der(0x06, Buffer.from(bytes))
}

const ipv4Bytes = (ip: string): Buffer => {
  if (!isIPv4(ip)) throw new Error(`${ip} is not an IPv4 address`)
  return Buffer.from(ip.split('.').map(Number))
}

/** A DER PKCS#10 request, with an empty subject, for a certificate on `ip` only. */
export const ipCsr = (ip: string, key: KeyObject): Buffer => {
  const subjectAltName = sequence(der(0x87, ipv4Bytes(ip)))
  const extensionRequest = sequence(
    oid('1.2.840.113549.1.9.14'),
    der(0x31, sequence(sequence(oid('2.5.29.17'), der(0x04, subjectAltName)))),
  )
  const info = sequence(
    der(0x02, Buffer.from([0])),
    sequence(),
    createPublicKey(key).export({ type: 'spki', format: 'der' }),
    der(0xa0, extensionRequest),
  )
  const signature = sign('sha256', info, key)
  return sequence(
    info,
    sequence(oid('1.2.840.10045.4.3.2')),
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  )
}

export const generateCertificateKey = (): KeyObject =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey

const jwk = (key: KeyObject) => {
  const { crv, kty, x, y } = key.export({ format: 'jwk' })
  return { crv, kty, x, y }
}

/** The RFC 7638 thumbprint: the members in lexicographic order, no whitespace. */
export const jwkThumbprint = (key: KeyObject): string => {
  const { crv, kty, x, y } = jwk(key)
  return base64url(createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest())
}

interface AcmeDirectory {
  newNonce: string
  newAccount: string
  newOrder: string
  meta?: { profiles?: Record<string, string> }
}
interface AcmeOrder {
  status: string
  authorizations: string[]
  finalize: string
  certificate?: string
}
interface AcmeAuthorization {
  status: string
  challenges: { type: string; url: string; token: string; status: string }[]
}

export interface IssueIpCertificateOptions {
  ip: string
  directoryUrl: string
  accountKey: KeyObject
  /** The key the certificate is issued for. */
  certificateKey: KeyObject
  /** Where the CA connects for http-01: 80, except in tests. */
  httpPort: number
  log: (message: string) => void
  fetchFn?: typeof fetch
}

const listen = (server: Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EACCES'
          ? new Error(
              `Cannot listen on port ${port} for the Let's Encrypt challenge: ${PRIVILEGED_PORTS_HINT}`,
            )
          : error,
      )
    })
    server.listen(port, resolve)
  })

/** Orders a `shortlived` certificate on `ip` and answers its http-01 challenge on `httpPort`; resolves with the PEM chain. */
export const issueIpCertificate = async ({
  ip,
  directoryUrl,
  accountKey,
  certificateKey,
  httpPort,
  log,
  fetchFn = fetch,
}: IssueIpCertificateOptions): Promise<string> => {
  const request = (url: string, init?: RequestInit) =>
    fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const directory = (await (await request(directoryUrl)).json()) as AcmeDirectory
  if (!directory.meta?.profiles?.[ACME_SHORTLIVED_PROFILE]) {
    throw new Error(`${directoryUrl} offers no ${ACME_SHORTLIVED_PROFILE} profile`)
  }
  let nonce: string | null = null
  let kid: string | null = null
  const newNonce = async () => {
    const response = await request(directory.newNonce, { method: 'HEAD' })
    return response.headers.get('replay-nonce') ?? ''
  }
  const post = async (url: string, payload: unknown, retried = false): Promise<Response> => {
    const header = {
      alg: 'ES256',
      nonce: nonce ?? (await newNonce()),
      url,
      ...(kid ? { kid } : { jwk: jwk(accountKey) }),
    }
    const protectedHeader = base64url(JSON.stringify(header))
    const body = payload === undefined ? '' : base64url(JSON.stringify(payload))
    const signature = sign('sha256', Buffer.from(`${protectedHeader}.${body}`), {
      key: accountKey,
      dsaEncoding: 'ieee-p1363',
    })
    const response = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json' },
      body: JSON.stringify({
        protected: protectedHeader,
        payload: body,
        signature: base64url(signature),
      }),
    })
    nonce = response.headers.get('replay-nonce')
    if (response.ok) return response
    const problem = (await response.json().catch(() => ({}))) as { type?: string; detail?: string }
    if (problem.type === 'urn:ietf:params:acme:error:badNonce' && !retried) {
      return post(url, payload, true)
    }
    throw new Error(`${url} answered ${response.status}: ${problem.detail ?? problem.type ?? ''}`)
  }
  const getAs = async <T>(url: string) => (await (await post(url, undefined)).json()) as T
  const poll = async <T extends { status: string }>(url: string, done: (value: T) => boolean) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    for (;;) {
      const value = await getAs<T>(url)
      if (done(value) || value.status === 'invalid') return value
      if (Date.now() > deadline) throw new Error(`${url} is still ${value.status}`)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  kid = (await post(directory.newAccount, { termsOfServiceAgreed: true })).headers.get('location')
  const created = await post(directory.newOrder, {
    identifiers: [{ type: 'ip', value: ip }],
    profile: ACME_SHORTLIVED_PROFILE,
  })
  const orderUrl = created.headers.get('location') ?? ''
  const order = (await created.json()) as AcmeOrder

  const keyAuthorizations = new Map<string, string>()
  const challengeServer = createServer((request, response) => {
    const token = request.url?.match(/^\/\.well-known\/acme-challenge\/([\w-]+)$/)?.[1]
    const answer = token ? keyAuthorizations.get(token) : undefined
    response.writeHead(answer ? 200 : 404, { 'content-type': 'text/plain' }).end(answer ?? '')
  })
  await listen(challengeServer, httpPort)
  try {
    for (const url of order.authorizations) {
      const authorization = await getAs<AcmeAuthorization>(url)
      if (authorization.status === 'valid') continue
      const challenge = authorization.challenges.find(({ type }) => type === 'http-01')
      if (!challenge) throw new Error(`${url} offers no http-01 challenge`)
      keyAuthorizations.set(challenge.token, `${challenge.token}.${jwkThumbprint(accountKey)}`)
      log(`answering the Let's Encrypt challenge for ${ip} on port ${httpPort}`)
      await post(challenge.url, {})
      const result = await poll<AcmeAuthorization>(url, ({ status }) => status === 'valid')
      if (result.status !== 'valid') {
        throw new Error(
          `The challenge for ${ip} failed: ${JSON.stringify(result.challenges.map(({ status }) => status))}, check that port ${httpPort} is reachable from the internet`,
        )
      }
    }
  } finally {
    challengeServer.close()
  }

  await poll<AcmeOrder>(orderUrl, ({ status }) => status === 'ready')
  await post(order.finalize, { csr: base64url(ipCsr(ip, certificateKey)) })
  const issued = await poll<AcmeOrder>(orderUrl, ({ status }) => status === 'valid')
  if (issued.status !== 'valid' || !issued.certificate) {
    throw new Error(`The order for ${ip} ended ${issued.status}`)
  }
  return (await post(issued.certificate, undefined)).text()
}
