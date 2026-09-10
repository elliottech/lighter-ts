# `hooks` — reference data loaders

Four React hooks that keep protocol metadata in the store fresh. They are the
REST half of the data flow; the websocket half lives in
[`../ws-sub-store`](../ws-sub-store).

| Hook | Loads | Into |
|---|---|---|
| `useInitTokens` | Token list | `tokens` |
| `useInitOrderBookMetas` | Perps + spot market definitions | `perpsOrderBookMetas`, `spotOrderBookMetas`, `orderBookMetasLoaded` |
| `useInitAssetMetas` | Asset definitions | `assetMetas`, `assetMetasLoaded` |
| `useInitL1Info` | Layer-1 chain info | `l1Info` |

Mount each once, near the root of the app. They render nothing and return
nothing — they exist for their effect on the store.

```tsx
function AppData() {
  useInitTokens()
  useInitOrderBookMetas()
  useInitAssetMetas()
  useInitL1Info()
  return null
}
```

They require a `QueryClientProvider` above them, and `initCommonPackage` to have
run (they call through `lib/apis`).

## The pattern

Each is a react-query `useQuery` paired with a `useEffect` that pushes the result
into the store:

```ts
const query = useQuery({ queryKey: [...], queryFn: ..., refetchInterval: INIT_DATA_REFETCH_INTERVAL })

useEffect(() => {
  if (!query.data) return
  useLighterStore.setState({ ... })
}, [query.data])
```

react-query owns fetching, caching and polling; the store stays the single place
components read from. All four poll on `INIT_DATA_REFETCH_INTERVAL` — 5 minutes, from
`../utils/common.ts` — with `staleTime` set to match, so a remount inside the
window reuses the cache instead of refetching.

## What the metadata hooks do on the way in

`useInitOrderBookMetas` and `useInitAssetMetas` are not pass-throughs. Each
response is:

1. **Widened** with `getDisplayDecimals` — adding `display_price_decimals` /
   `display_size_decimals` derived from the market's decimals and multiplier
   (see [`../utils`](../utils) on real vs. display units).
2. **Trimmed** with `pick` to the field lists in `../constants/pickedFields.json`.
   The API returns considerably more than the app uses, and these objects are
   held per market in memory and compared by selectors.
3. **Keyed** by `market_id` / `asset_id` into a lookup map.
4. **Symbol-mapped** through `withDisplaySymbol`, using `selectDisplaySymbols`
   from the token list.

Step 4 is why these hooks depend on `useInitTokens` having populated the store:
display symbols come from the token list. The dependency is soft — metadata loads
regardless, and re-runs when `displaySymbols` changes — so mount order doesn't
matter.

The store starts from [`../fallbacks`](../fallbacks), so these hooks are
refreshing existing data rather than filling a void.
