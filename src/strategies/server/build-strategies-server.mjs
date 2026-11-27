#!/usr/bin/env node
// Bundles the strategies server (server.main, server.worker and the
// strategies-server launcher) into the given dir, with the signer files
// download-signer-wasm.mjs fetched next to it in web-wasm/.

import { chmod, copyFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

await import('./download-signer-wasm.mjs')

const outdir = resolve(process.argv[2] ?? '.server')
const SERVER_DIR = import.meta.dirname
// The ESM bundle holds CommonJS dependencies (ws) that call require.
const REQUIRE_BANNER =
  "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);"

const options = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  alias: {
    '@formatjs/intl-pluralrules/locale-data/en': '@formatjs/intl-pluralrules/locale-data/en.js',
    '@formatjs/intl-numberformat/locale-data/en': '@formatjs/intl-numberformat/locale-data/en.js',
  },
}

await rm(outdir, { recursive: true, force: true })
await build({
  ...options,
  entryPoints: [join(SERVER_DIR, 'server.main.ts'), join(SERVER_DIR, 'server.worker.ts')],
  banner: { js: REQUIRE_BANNER },
})
await build({
  ...options,
  entryPoints: [join(SERVER_DIR, 'launcher.ts')],
  banner: { js: '#!/usr/bin/env node' },
})
await chmod(join(outdir, 'launcher.mjs'), 0o755)

await mkdir(join(outdir, 'web-wasm'))
for (const name of ['main.wasm', 'wasm_exec.js', 'main.manifest.json']) {
  await copyFile(join(SERVER_DIR, 'web-wasm', name), join(outdir, 'web-wasm', name))
}
