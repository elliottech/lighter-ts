# `fallbacks` — bundled reference data

Static JSON snapshots of protocol metadata, one directory per environment that has one.

## How they load

Each env directory's `index.ts` default-exports its snapshot as a `Fallbacks`
object.
`staging` and `testnet` have their own snapshots but take `tokens` from mainnet's,
and `robinhood-testnet` takes them from `robinhood-mainnet`'s. `local` has only
mainnet's `tokens` (a `TokensOnlyFallbacks`), so it still waits for the API metas.
The package exports them as `@elliottech/react-store/fallbacks/<env>`, and the
store itself imports none of them.

Without a matching snapshot, metas, assets and tokens start empty and wait for
the API (a tokens-only snapshot seeds the tokens), and the websocket opens only once both the order book and asset metas
have loaded, so account snapshots are never filtered against empty metas.
`systemConfig`, `l1Info` and the fee tiers always start from the Lighter
mainnet defaults in `defaults.ts`, so they are never `null`.

| File | Contents |
|---|---|
| `orderBookMetas.json` | Perps and spot market definitions. By far the largest. |
| `tokens.json` | The token list: symbols, categories, logos. Absent where `/tokenlist` fails. |
| `assetMetas.json` | Asset definitions and decimals. |
| `systemConfig.json` | Protocol-level configuration. |
| `l1Info.json` | Layer-1 chain info and contract addresses. |
| `feeTiers.json` | Fee tiers. Hand-maintained for Robinhood, whose `/feeTiers` is unavailable. |

`index.ts` in each directory exports the snapshot as a `Fallbacks` object.

## Updating

These are re-generated automatically.
