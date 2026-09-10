# `lib` — the dependency-injection registry

Everything this package needs from the host application, and cannot provide
itself.

## Why this exists

The same trading core runs on different environments. Those environments have no
common answer for storage, crypto, HTTP clients or transaction signing:


Rather than branch on platform inside the core, each capability is a **mutable
singleton object** exported from this directory, holding stubs until the host
fills it in.

## The pattern

Each module exports one object with placeholder members:

```ts
// lib/persistence.ts
export interface Persistence {
  setItem: (key: string, value: string) => void
  getItem: (key: string) => string | null
}

export const persistence: Persistence = {
  setItem: () => {},
  getItem: () => null,
}
```

Consumers import the object and reach through it at call time — never
destructure at import time, or you'll capture the stub:

```ts
import { persistence } from '../lib/persistence'

persistence.getItem('preferences')       // ✅ resolves the live implementation
const { getItem } = persistence          // ❌ frozen to the stub forever
```

`initCommonPackage` ([`../utils/initCommonPackage.ts`](../utils/initCommonPackage.ts))
mutates these objects in place. It is the only thing that should write to them.

## What's registered here

| Module | Holds | Uninitialized behavior |
|---|---|---|
| `apis.ts` | The fifteen generated REST clients from `zklighter-perps` (account, order, info, bridge, candlestick, referral, …) | `null!` — throws on use |
| `env.ts` | Current environment (`local` / `staging` / `testnet` / `mainnet` / `robinhood-*`) and the `isRobinhoodEnv()` predicate | `null!` |
| `transactionConfig.ts` | Signers, API key index, platform, registration check, `skipNonce` | `null!` |
| `sha256.ts` | Hashing used by the transaction path | Rejects with an explicit "not initialized" error |
| `persistence.ts` | Key/value storage backing user preferences | No-op; reads return `null` |
| `errorReporting.ts` | `captureException` | No-op returning `''` |
| `errorToast.ts` | `showToastFromError` — surfaces API errors in the host's toast UI | No-op |

## Notes

- **`null!` is deliberate.** These are typed as non-nullable so call sites don't
  have to null-check on every access. The cost is that using them before
  `initCommonPackage` throws a `TypeError` rather than failing gracefully.
  `sha256` is the exception — it rejects with a message naming the cause.
- **`isRobinhoodEnv()` gates real behavior**, not just labels. Robinhood runs
  against a different exchange, so `initCommonPackage` clears the bundled Lighter
  fallbacks when that env is active, and several hooks and selectors branch on it.
- **This is global mutable state**, which means tests that call
  `initCommonPackage` share it. Set up what you need per test rather than
  assuming a clean registry.
