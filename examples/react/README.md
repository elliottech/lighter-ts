# React example

A plain Vite + React + TypeScript app, used as the starting point for the
`lighter-ts` usage examples.

Stack: React 19, Vite 8, TypeScript 6, Oxlint.

## Running it

The SDK is consumed from its **build output**, so the repo root has to be built
before this app will resolve `lighter-ts`:

```sh
cd ../.. && yarn build   # emits dist/, which is gitignored
cd examples/react
yarn install
yarn dev
```

Re-run the root `yarn build` after changing anything under `../../src` — there is
no HMR across the link.

| Script | What it does |
|---|---|
| `yarn dev` | Dev server with HMR on http://localhost:5173 |
| `yarn build` | Typecheck (`tsc -b`) then build to `dist/` |
| `yarn preview` | Serve the production build |
| `yarn lint` | Oxlint |


## WASM

WASM code is public at [@elliottech/lighter-go/web-wasm](https://github.com/elliottech/lighter-go/tree/main/web-wasm).

To update copy `main.wasm, main.wasm.br, main.wasm.gz` to `src/lib/signers/wasm`