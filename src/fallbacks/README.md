# `fallbacks` — bundled reference data

Static JSON snapshots of protocol metadata, compiled into the package.

## Why these are bundled

The store in [`../store`](../store) is created at **import time**, before any
network request has been made. Seeding it from these files means the app can
render the market list, resolve symbols and format prices on first paint instead
of showing empty state until the first API response lands.

They are also the degraded-mode floor: if the metadata endpoints are unreachable,
the app still knows what markets exist.

| File | Contents |
|---|---|
| `orderBookMetas.json` | Perps and spot market definitions. By far the largest — the bulk of this directory's weight. |
| `tokens.json` | The token list: symbols, categories, logos. |
| `assetMetas.json` | Asset definitions and decimals. |
| `systemConfig.json` | Protocol-level configuration. |
| `l1Info.json` | Layer-1 chain info. |

`index.ts` re-exports each as a named `*Fallback` binding.

## Updating

These are re-generated automatically.
