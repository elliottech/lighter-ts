#!/usr/bin/env node
// Downloads the strategies server's signer files described by web-wasm/main.manifest.json next to it
// and checks them against the manifest's hashes.

import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// lighter-go commit holding the main.wasm the manifest describes. The manifest's
// sourceCommit is the source it was built from, which holds an older main.wasm.
const LIGHTER_GO_COMMIT = 'c2986f02a14e0689461655e5686ca911c7854ea2'

const dir = join(import.meta.dirname, 'web-wasm')
const manifest = JSON.parse(await readFile(join(dir, 'main.manifest.json'), 'utf8'))

const files = [
  {
    name: 'main.wasm',
    url: `https://raw.githubusercontent.com/elliottech/lighter-go/${LIGHTER_GO_COMMIT}/web-wasm/main.wasm`,
    sha256: manifest.sha256,
  },
  {
    name: 'wasm_exec.js',
    url: `https://raw.githubusercontent.com/golang/go/${manifest.goVersion}/lib/wasm/wasm_exec.js`,
    sha256: manifest.runtimeSha256,
  },
]

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

const readIfExists = async (path) => {
  try {
    return await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

for (const { name, url, sha256: expected } of files) {
  const path = join(dir, name)
  const existing = await readIfExists(path)
  if (existing && sha256(existing) === expected) continue

  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading ${url} failed with ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  const actual = sha256(data)
  if (actual !== expected) {
    throw new Error(`${url} has sha256 ${actual}, main.manifest.json expects ${expected}`)
  }

  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  console.log(`Downloaded ${name} (${data.length} bytes)`)
}
