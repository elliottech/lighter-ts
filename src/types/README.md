# `types` — domain types and the compatibility layer

Types shared across the package. Most are ordinary domain models; the important
one is `compatibility.ts`.

## `compatibility.ts` — narrowing the generated API types

The `zklighter-perps` package is generated from the API spec, which makes its
types accurate about the wire and awkward as domain models. This file re-shapes
them for three reasons:

**1. Narrowing discriminants.** The generated `market_type` is a `string`; here it
becomes the literal `'spot'` or `'perp'`, so `OrderBookDetail` is a discriminated
union and `isMarketSpot()` narrows properly.

**2. Stripping duplicated state.** Market stats (`last_trade_price`,
`daily_price_change`, `daily_chart`, …) come down the websocket and live in
`perpsMarketsStats` / `spotMarketsStats`. The REST metadata carries them too, so
they're `Omit`ted here — one source of truth, no stale copy in a second place.

**3. Adding computed fields.** `backend_symbol`, `display_price_decimals` and
`display_size_decimals` do not exist on the wire. They're injected as metadata is
loaded (see [`../utils`](../utils) on real vs. display units) and are always
present on the types in this file.

```ts
export type PerpsOrderBookDetail = Omit<
  BEPerpsOrderBookDetail,
  'market_type' | StrippedMarketStatsFields | 'open_interest'
> & {
  market_type: 'perp'
  backend_symbol: string
  display_price_decimals: number
  display_size_decimals: number
}
```

Related re-shaping of *account* types (string→number parsing) lives in
[`../store/types.ts`](../store/types.ts).

## The rest

| Module | Contents |
|---|---|
| `signers.ts` | The `Signers` interface — every transaction the host must be able to sign (orders, margin, leverage, sub-accounts, public pools, transfers, withdrawals, key management, auth tokens), plus each one's params. The contract between this package and the platform's signing implementation; see [`../lib`](../lib). |
| `order.ts` | `OrderType`, order placement inputs, and the `CreateOrderParams` / `ModifyOrderParams` / `CancelOrderParams` family. Also `IntegratorFees` — fees in millionths of notional, so 1bp = 100. |
| `tokenlist.ts` | `Token` (an API token with `backend_symbol` guaranteed), `TokenCategory` and its display order, market type and category filters. |
| `user.ts` | Protocol transaction enums with their **on-the-wire numeric values**: `TxTypes` (8, 9, 12, 14, …), `TxOrderTypes`, `TxTimeInForceTypes`, `TxGroupingTypes` (OTO / OCO / OTOCO). The numbers are protocol constants — do not renumber them. |
| `user-tiers.ts` | `UserTier` and the expanded `ExtendedUserTier` (premium 1–7). |
| `MarginMode.ts` | `CROSS` (0) / `ISOLATED` (1). |
| `accountTradingMode.ts` | `CLASSIC` (0) / `UNIFIED` (1). |
| `Platform.ts` | Web / mobile app / mobile browser, sent with signed transactions. |
| `OrderHistoryRow.ts` | A flattened order joined with its market, for table rendering. |

## The const-object enum pattern

Most enums are written as a const object plus a lookup type:

```ts
export const MarginMode = { CROSS: 0, ISOLATED: 1 } as const
export type MarginMode = (typeof MarginMode)[keyof typeof MarginMode]
```

This gives a value and a type under one name, erases completely at build time,
and works under `isolatedModules` / `verbatimModuleSyntax` — which TS `enum` does
not. Prefer it for anything new.

Real `enum`s remain where the members are protocol wire values that must be
written out explicitly (`TxTypes`, `TxOrderTypes`, `TxGroupingTypes` in
`user.ts`), plus `Platform` and `SubAccountType`.
