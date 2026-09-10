# `lighter-ws` — the websocket client

A thin wrapper over the browser `WebSocket` that decodes, validates and
normalizes messages from the Lighter server. It knows nothing about the store —
handing messages to state is [`../ws-sub-store`](../ws-sub-store)'s job.

## The client

```ts
import { LighterWs } from '@elliottech/react-store'

const ws = new LighterWs({
  baseUrl: 'wss://…',
  encoding: 'msgpack',      // or 'json'
  auth: { token },          // optional
  onOpen: (ws) => ws.sendMessage({ type: 'subscribe', channel: 'order_book/1' }),
  onMessage: (message, ws) => { /* fully typed WsMessage */ },
  onError: (err, tags) => {},
  onClose: () => {},
})
```

The constructor connects immediately. Query parameters (`encoding`, `readonly`,
`auth`, `server`) are assembled from the params; with `msgpack` the socket's
`binaryType` is set to `arraybuffer`.

The surface is deliberately small: `sendMessage(message)` and `close()`.
Subscription bookkeeping, acknowledgement tracking and retry are **not** handled
here — they belong to [`../ws-sub-store`](../ws-sub-store), which owns the
connection lifecycle. This directory contributes only the backoff schedule
(`utils/wsChannelReconnectTimeout.ts`: 3s → 6s → 10s → 15s).

## The receive path

Every inbound message goes through two steps before reaching `onMessage`:

```
raw frame ──▶ decodeWsMessage ──▶ transformWsMessage ──▶ onMessage
              (msgpack/JSON)      (normalize shapes)
```

**`decodeWsMessage`** unpacks msgpack (via `msgpackr`, with `int64AsNumber` and
`mapsAsObjects`) or parses JSON. On any decode failure it returns `null`, and the
client drops the message silently — the server emits null frames in groups of
three, and reporting them would be noise.

**`transformWsMessage`** (~400 lines) is where wire format becomes domain model:
numeric strings are parsed, field names are normalized, and margin percentages
are converted to fractions. A throw here is caught and routed to `onError` with
the tag `transform_ws_message`, so one malformed message can't tear down the
socket.

## Types

[`types/WsMessage.ts`](./types/WsMessage.ts) is the full inventory of server
messages — the single largest type file in the package, and the reference for
what the server can send. Messages are a discriminated union on `type`, paired as
`subscribed/x` (initial snapshot) and `update/x` (subsequent deltas):

```
subscribed/order_book        update/order_book
subscribed/trade_fe          update/trade_fe
subscribed/candle            update/candle
subscribed/account_all_orders  update/account_all_orders
…
```

That pairing is the protocol's core idea: **subscribe replaces, update merges.**
The handlers in `ws-sub-store` treat the two differently, and getting them
backwards produces state that looks right at first and drifts.

[`types/SendWsMessage.ts`](./types/SendWsMessage.ts) covers the outbound
direction: `ping`, `pong`, `subscribe`, `unsubscribe`, and the agent channel.
