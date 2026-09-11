# `public` — Lighter shared trading core

Framework-level building blocks for Lighter.xyz JavaScript clients: the
client-side state store, the websocket pipeline that feeds it, the trading math,
and the types that describe it all.

It is **UI-free**. There are no components here — only state, selectors,
pure functions and types. Rendering is the host app's job.

---

## Start here: the three things to understand

### 1. Nothing works until you call `initCommonPackage`

This package ships with no API clients, no storage, no crypto, and no signers.
The host application injects all of them at boot:

```ts
import { initCommonPackage } from '@elliottech/react-store'

initCommonPackage({
  env: 'mainnet',
  // storage — localStorage on web, AsyncStorage/MMKV on mobile
  getItem, setItem,
  // crypto — WebCrypto on web, a native module on mobile
  sha256,
  // generated REST clients from `zklighter-perps`
  accountApi, orderApi, infoApi, /* ...and the rest */
  // transaction signing (WASM on web, native on mobile)
  signers, getApiKeyIndex, getPlatform, isRegistered,
  // host-side plumbing
  websocketConfigParam, captureException, showToastFromError,
})
```

Until then the singletons in [`lib/`](./src/lib) hold `null!` or no-op stubs and will
throw or silently do nothing. See [`lib/README.md`](./src/lib/README.md) for why it's
built this way.

### 2. There is one global store, and it is not a React context

[`store/useLighterStore.ts`](./src/store/useLighterStore.ts) creates a single module-level
Zustand store, composed from nine slices. It exists the moment the module is
imported, so it can be read from anywhere — React components, websocket handlers,
plain functions — via `useLighterStore.getState()`.

Because it's created at import time, it is seeded with the bundled snapshots in
[`fallbacks/`](./src/fallbacks) so the app can render markets before the first network
response arrives.

### 3. "Real" and "display" numbers are different numbers

Every market has a `multiplier`. Prices and sizes on the wire ("real") are not
what users see ("display"):

```
display_size  = real_size  × multiplier
display_price = real_price ÷ multiplier
```

Mixing the two up is the single easiest way to introduce a pricing bug, so the
conversion helpers live in one place — [`utils/multiplier.ts`](./src/utils/multiplier.ts)
— and are documented in [`utils/README.md`](./src/utils/README.md).

---

## How data flows

```
                 ┌──────────────────────────────┐
   REST          │ hooks/  (react-query)        │
   (initial ─────▶ useInitTokens, useInitL1Info,│───┐
    + poll)      │ useInit{Asset,OrderBook}Metas│   │
                 └──────────────────────────────┘   │
                                                    ▼
   WebSocket     ┌───────────┐   ┌──────────────┐  ┌─────────────────┐
   (live)  ──────▶ lighter-ws├──▶  ws-sub-store ├──▶  store/         │
                 │  decode + │   │  buffer +    │  │  useLighterStore│
                 │  transform│   │  throttle    │  └────────┬────────┘
                 └───────────┘   └──────────────┘           │
                                                             ▼
                                                    ┌─────────────────┐
                                                    │ store/**/       │
                                                    │ selectors.ts    │  ← memoized (reselect)
                                                    └────────┬────────┘
                                                             ▼
                                                    ┌─────────────────┐
                                                    │ formulas/       │  ← pure math
                                                    └────────┬────────┘
                                                             ▼
                                                          host UI
```

Reads flow one way: **store → selectors → formulas → UI**. Writes come from the
websocket bridge, the init hooks, and [`actions/`](./src/actions).

---

## Directory map

| Directory | What's in it |
|---|---|
| [`store/`](./src/store) | The Zustand store: nine slices, and the memoized selectors that read them. The largest and most intricate part of the package. |
| [`ws-sub-store/`](./src/ws-sub-store) | The bridge from websocket messages to store writes. Buffers high-frequency updates and flushes on an interval. |
| [`lighter-ws/`](./src/lighter-ws) | The websocket client itself, plus the full type surface of every server message. |
| [`formulas/`](./src/formulas) | Pure trading math — PnL, margin, liquidation prices, order matching, SL/TP. No store access, no I/O. |
| [`utils/`](./src/utils) | Unit conversion, decimal-safe rounding, candlestick assembly, fee tiers, input sanitizing. |
| [`types/`](./src/types) | Domain types, and the compatibility layer that narrows the generated `zklighter-perps` types. |
| [`lib/`](./src/lib) | The dependency-injection registry — mutable singletons filled in by `initCommonPackage`. |
| [`hooks/`](./src/hooks) | The four react-query hooks that load reference data (tokens, markets, assets, L1 info) into the store. |
| [`fallbacks/`](./src/fallbacks) | Bundled JSON snapshots of market/asset/token metadata, so the store is populated at import time. |
| `constants/` | Shared constants: protocol addresses, tx statuses, slippage limits, date formats, and the field lists used to trim API payloads. |
| `actions/` | Imperative store writes that are too stateful for a selector. |
| `images/` | CDN URL builders for token and chain icons. No bundled image assets. |
| `testing/` | `isTestingEnvironment()` — a single flag read from `process.env.VITE_PLAYWRIGHT`. |

## Conventions

- **Barrel files.** Every directory has an `index.ts` re-exporting its public
  surface, and `public/index.ts` re-exports all of them. Import from the package
  root; the deep paths are an implementation detail.
- **`select*` is a selector**, takes `(state)` or `(state, params)`, and is
  memoized. `compute*` is a pure formula and takes plain values.
- **Enums are const objects.** `MarginMode`, `OrderType`, and friends use the
  `as const` + lookup-type pattern rather than TS `enum`, so they survive
  `isolatedModules` and erase cleanly.
- **Tests** are colocated as `*.test.ts` and run with `vitest`.
