# `ws-sub-store` — subscription manager and store bridge

The name is "websocket **sub**scription **store**". Two jobs live here:

1. **`useWsSubStore.ts`** — owns the connection and every subscription on it.
2. **`utils.ts`** — turns inbound messages into writes on the main
   [`../store`](../store).

Together they close the loop between [`../lighter-ws`](../lighter-ws) (the raw
socket) and application state.

---

## 1. The subscription store

`useWsSubStore` is a **second Zustand store**, separate from `useLighterStore`.
The split is intentional: this one holds *connection* state (which socket, which
channels, retry counters), while `useLighterStore` holds *domain* state (prices,
positions, orders). Connection churn shouldn't re-render anything reading market
data.

```ts
const { actions } = useWsSubStore.getState()

await actions.init(url, triggerWsNotification, getOrCreateAuthToken, 'msgpack', null)
actions.subscribeMarket(marketId)
actions.subscribeCandle(marketId, '1h')
```

On open it subscribes to the always-on channels (perps stats, spot stats, asset
stats) and re-syncs candle subscriptions. On close it clears every pending retry
timer, resets account/pool indices, and fails any in-flight agent exchanges.

### Channel acknowledgement and retry

Subscriptions are not fire-and-forget. `subscribeChannel` sends the message
**and** schedules a retry:

```
subscribeChannel(msg)
  ├─ clearTimeout(existing)          ← a re-subscribe before the ack must not
  │                                     orphan the pending timer
  ├─ channels[ch] = { retries: n+1, timeout: setTimeout(retry, backoff(n+1)) }
  └─ ws.sendMessage(msg)

        …server replies `subscribed/<channel>`…

markAsSubscribed(ch)
  └─ clearTimeout  →  channels[ch] = { retries, timeout: null }
```

Backoff comes from `wsChannelReconnectTimeout` (3s → 6s → 10s → 15s), capped at
`MAX_WS_CHANNEL_SUBSCRIBE_RETRIES` (10).

This is why the predicates in [`channels.ts`](./channels.ts) are shaped the way
they are: **a channel is "loading" exactly when it still has a pending timeout**,
because an acknowledged channel has had its timer cleared.

```ts
channelNotConnected(ch)     // never subscribed — undefined
channelIsLoading(ch)        // subscribe sent, ack not yet received
channelFailedToConnect(ch)  // still pending after 10 tries
```

### Refcounted candle subscriptions

Several components can chart the same market and resolution at once, so candle
subscriptions are **refcounted** by `${marketId}/${resolution}`.
`subscribeCandle` / `unsubscribeCandle` adjust the count;
`syncSharedCandleSubscription` diffs the desired set against
`activeCandleChannels` and reconciles the socket.

The channel name also depends on a user preference — `showMarkPriceCandles`
switches between `candle/…` and `mark_price_candle/…` — which is why the sync
step exists rather than subscribing directly.

---

## 2. The store bridge

### Buffering

A busy market produces order book and trade updates far faster than any UI can
render. Writing each straight to the store would mean a re-render per message.

High-frequency data is instead accumulated in module-level buffers and flushed on
an interval:

```
  ws messages ──▶ handleWsMessage ──▶ bufferedOrderbook
   (continuous)      (switch on          bufferedTrades
                      message type)      bufferedPerpsMarketsStats
                                         bufferedNewCandlesticks
                                         …
                                                │
                                    setInterval(throttleInterval)
                                                │
                                                ▼
                                    one useLighterStore.setState()
```

`throttleInterval` (default 500ms) is the client-side flush cadence.
`flushInterval` (default 250ms) is a *different* knob — it is sent to the server
on subscribe as `flush_interval`, asking it to batch upstream. Both are set by
the host through `initCommonPackage`.

Two details worth knowing:

- **The flush skips `setState` entirely when every buffer is empty**, rather than
  writing an unchanged object — writing would create new references and
  re-render subscribers for nothing.
- **Market stats merge in place** (`mergeInPlace`) instead of rebuilding the map
  per message, because they arrive constantly and the map is large.

Low-frequency messages — account updates, order fills, notifications — are
written straight through. Only the firehose is buffered.

### `handleWsMessage`

The entry point: a `switch` over message `type`, dispatching to a handler per
channel in `subscribed/` and `update/` pairs.

`subscribed/*` handlers **replace** their slice of state with the server
snapshot. `update/*` handlers **merge** a delta into what's there. Getting the
two backwards produces state that looks correct at first and then drifts.

### Market filtering

Not every market the server streams should be visible — the token list and URL
configuration decide. Incoming records pass through `selectAllowedMarketIds` /
`selectAllowedAssetIds` before reaching the store, so a market that isn't enabled
never lands in state.

### Also exported

- `selectWsSessionId` — reads `wsSessionId` off the subscription store.
- `subscribeToAccountTx` / `unsubscribeToAccountTx` — observe executed
  transactions as they arrive. Remember to unsubscribe.
- Agent thread helpers — `appendAgentExchange`, `patchInFlightAgentExchanges`,
  `clearAgentThread`, `failInFlightAgentExchanges`, `newAgentExchangeId`.
- `clearBufferedCandlesticksForKey`, `handleChangeDesiredMarket`.

---

## Caveats

`utils.ts` holds module-level mutable buffers and a single shared interval, and
`useWsSubStore` assumes one connection. Both are effectively singletons: fine for
an app with one socket, but tests must account for state persisting across cases,
and driving two connections concurrently is not supported.
