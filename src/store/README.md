# `store` — global state and selectors

A single [Zustand](https://zustand.docs.pmnd.rs/) store composed from nine
slices, plus the memoized selectors that read it.

## The store

[`useLighterStore.ts`](./useLighterStore.ts) creates one module-level store
wrapped in `subscribeWithSelector`:

```ts
export const useLighterStore = create<LighterStore>()(
  subscribeWithSelector((...args) => ({
    ...createAccountsSlice(...args),
    ...createAgentSlice(...args),
    // ...seven more
  })),
)
```

`LighterStore` is the intersection of all nine slice types, so state is flat —
there is no `state.accounts.accounts` nesting from the composition itself.

Two consequences worth internalizing:

- **It is created at import time.** Not in a provider, not in a hook. Any module
  can call `useLighterStore.getState()` / `.setState()`, and the websocket layer
  does exactly that. There is no React context to thread through.
- **It is seeded from [`../fallbacks`](../fallbacks)** — bundled market, asset
  and token metadata — so selectors return usable data before any network call
  completes.

## Slices

| Slice | State it owns |
|---|---|
| `orderbook/` | Market and asset metadata, market stats, the live order book, trades, candlesticks, block height, system config. The biggest slice. |
| `accounts/` | Per-account positions, balances, orders, trades, RFQs, pool info, volumes. Keyed by account index. |
| `user/` | The active account, L1 address, tier, and a large set of UI flags (which modal is open, which chart section is shown). |
| `preferences/` | Everything persisted to storage — see below. |
| `place-order/` | The order-entry form: amounts, prices, SL/TP, TWAP and scale inputs. |
| `tokens/` | The token list and symbol lookups. |
| `agent/` | Conversational agent threads and their in-flight exchanges. |
| `table-filters/` | Filter state for the data tables. |
| `repeat-order/` | Prefill carried over when repeating a previous order. |

Each slice directory holds `create<Name>Slice.ts` (state shape + initial values)
and usually `selectors.ts`.

### The preferences slice is validated, not trusted

[`preferences/createPreferencesSlice.ts`](./preferences/createPreferencesSlice.ts)
persists user settings through `lib/persistence` and parses them back with a Zod
schema where **every field has a `.catch(default)`**. Stored preferences come
from an older version of the app on someone's device — a changed enum or a
renamed field must degrade to the default rather than throw. Add new preferences
by extending both `defaultPreferences` and the schema.

## Selectors

Two directories, and the split matters:

- **`<slice>/selectors.ts`** — selectors reading mostly that slice.
- **`selectors/`** — cross-slice selectors that combine several (order validation,
  updated stats, SL/TP, fees, scale orders).

### Memoization

Selectors are built with `createSelector` from [`utils/createSelector.ts`](./utils/createSelector.ts),
a `reselect` creator configured with an **LRU cache of size 5** on both the result
and the arguments.

The LRU (rather than reselect's default single-entry memoization) is what makes
the parameterized pattern below viable: the same selector called for five
different markets in five different components stays memoized for all of them.
Past that, entries evict and recompute.

[`createDeepEqualSelector.ts`](./utils/createDeepEqualSelector.ts) adds a
`lodash.isEqual` result check, for selectors that rebuild an object each run but
whose consumers should not re-render when the contents are unchanged. It is more
expensive — reach for it when the output is small and re-renders are costly.

### Parameterized selectors

Selectors take `(state, params)`. [`params/selectors.ts`](./params/selectors.ts)
holds the tiny extractors that pull values out of `params`, so they can be
composed as inputs like any other selector:

```ts
export const selectMarketId = (_state, params: { marketId: number }) => params.marketId
```

Several fall back to store state when the param is absent — `selectAccountIndex`
returns `params?.accountIndex ?? state.accountIndex`, letting a component either
name an account explicitly or inherit the active one.

### `createTracking`

[`utils/tracking.ts`](./utils/tracking.ts) wraps selector bodies to record call
counts and timings. **It is a no-op unless `isTestingEnvironment()` is true**, so
it costs nothing in production. When active it exposes
`window.getSelectorStats()` and `window.clearSelectorStats()` for finding
selectors that recompute more than they should.

## Types

[`types.ts`](./types.ts) defines the domain models. Two conventions:

- Websocket models are **re-exported under domain names** (`export type Position =
  WsPosition`) rather than used directly, so the wire format can change without
  touching consumers.
- Generated `zklighter-perps` types are **re-shaped with `Omit` + numeric fields**.
  The API sends numbers as strings; these types describe the parsed form the
  store actually holds.

## Adding a slice

1. Create `<name>/create<Name>Slice.ts` exporting the state interface and a `StateCreator`.
2. Add it to the intersection type and the spread in `useLighterStore.ts`.
3. Add `<name>/index.ts`, and export it from [`index.ts`](./index.ts).
4. Put selectors in `<name>/selectors.ts` — or in `selectors/` if they span slices.
