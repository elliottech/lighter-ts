# `utils` — conversions, precision and shared helpers

Stateless helpers. A few of these encode rules that are easy to get wrong, so
read the first two sections before using anything here.

## Real vs. display units — read this first

Every market carries a `multiplier`. The numbers on the wire ("real") are not the
numbers users see ("display"):

```
display_size  = real_size  × multiplier
display_price = real_price ÷ multiplier
```

A market with `multiplier: 2` quotes a low-priced token per 2 units — the
user sees a price 2× smaller and a size 2× larger than the chain does. Multiplier
values should be in the range `(0.1, 10)`.

[`multiplier.ts`](./multiplier.ts) owns every conversion:

| Function | Direction |
|---|---|
| `realSizeToDisplay` / `displaySizeToReal` | size, both ways |
| `realPriceToDisplay` / `displayPriceToReal` | price, both ways |
| `realCandlesticksToDisplay` | OHLC + base volume in one pass |
| `getDisplayDecimals` | derives `display_price_decimals` / `display_size_decimals` from the market's decimals and multiplier |

Two subtleties:

- **Rounding direction is asymmetric.** Converting *to* display ceils; converting
  *to* real floors. Each is nudged by a fraction of a tick first, so a value that
  round-trips lands back where it started instead of drifting a tick.
- **`displayPriceToReal` takes an `isShort` flag.** For sells it verifies the
  result round-trips and bumps by one tick if not, so a short's real price never
  rounds to a worse display price than the user agreed to.

Market metadata reaching the store already has display decimals injected (by the
init hooks, via `getDisplayDecimals`), so consumers can rely on those fields.

## Decimal precision

[`precision.ts`](./precision.ts) — never round prices with bare `Math.round`.

`ceilNumber`, `floorNumber` and `roundNumber` use a **fast path** that shifts the
decimal point with string exponent notation (`` `${num}e${decimal}` ``) to avoid
the binary error in `x * 1e5`, then fall back to `decimal.js` when the precision
is ≥ 6 places or the fast result isn't finite.

`roundNumber` rounds on the absolute value, so `-9.5 → -10` rather than
`Math.round`'s `-9`. Half-away-from-zero is what a trader expects; half-up is not.

## Everything else

| Module | Contents |
|---|---|
| `common.ts` | Input sanitizing (`sanitizeNumberInput`, `isPartialNumericInput`, `enforcePriceLimit`), base↔float conversion, PnL/inflow aggregation over time buckets, RPC URLs, maintenance-mode checks, address shortening, `isMarketSpot`. |
| `candlesticks.ts` | Building and extending live candles: trade and mark-price candles, TradingView resolution mapping (`tvResToObRes`, `tvResToResInMiliseconds`), continuous-open stitching, merging trade and mark-price series, historical fetch. |
| `fees.ts` | Static fee-tier tables for Lighter and Robinhood (standard / plus / premium 1–7) and the lookups over them. |
| `filters.ts` | Portfolio timelines (`1D`, `1W`, …) — start timestamps, resolutions, custom ranges. |
| `initCommonPackage.ts` | The package entry point. See [`../lib`](../lib). |
| `marketFlags.ts` | Decoding `market_flags` into a `MarginMode`. Note the two different readings: `getDefaultMarketMarginModeFromFlags` (what a market defaults to) vs. the internal check behind `isMarketIsolatedOnly` (what it permits). |
| `synthetic-market-details.ts` | Placeholder `OrderBookDetail` entries for markets that are announced but not yet listed, so the UI can show them without special-casing. |
| `normalizeTokens.ts`, `withDisplaySymbol.ts` | Symbol normalization — see below. |
| `getMarketDisplayPrice.ts`, `selectMarketDisplayPrice.ts` | Mid price, falling back to last trade price when there is no book. |
| `isOrderActive.ts` | `Open` / `Pending` / `InProgress` are active; everything else is not. |

## Backend vs. display symbols

A market's on-chain symbol isn't always what the user should read. The rule:

- `backend_symbol` — what the protocol calls it. **Always present** after
  normalization; use it for anything addressing the protocol.
- `symbol` — what to show. Substituted from the token list where one exists.

`normalizeTokens` guarantees `backend_symbol` is populated (the API leaves it
optional), and `withDisplaySymbol` swaps `symbol` for the display name while
preserving the original as `backend_symbol`.

## Tests

`candlesticks.test.ts` and `filters.test.ts` are colocated and run with `vitest`.
Both cover date/precision edge cases — `filters.test.ts` manipulates `process.env.TZ`
to check timezone handling.
