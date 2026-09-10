# `formulas` — trading math

Pure functions. No store access, no I/O, no React. Give them numbers, get numbers
back.

## Units

Formulas operate on **real** (protocol) units unless a name says otherwise —
callers convert at the boundary with [`../utils/multiplier.ts`](../utils/multiplier.ts).
`computeDisplayTotalUnrealizedPnl` is the explicit exception.

Margin is expressed three ways, with converters in `common.ts`:

```
fraction  ←→  percentage  ←→  leverage
              marginFractionToPercentage
              marginFractionToLeverage
              leverageToMarginFraction
```

`MARGIN_FRACTION_TICK` (10,000) in `../constants/shared.ts` is the protocol's
fixed-point scale for fractions.

## What's where

| Module | Contents |
|---|---|
| `common.ts` | The core account math: position PnL, realized PnL, collateral, leverage, margin usage, **liquidation prices** (`computePositionLiquidationPrice`, `computePositionsLiqPrices`), initial and maintenance margin requirements, spot and perps equity. The largest file here. |
| `orderMargin.ts` | How much margin an order consumes, and how much is available: `computeOrderMargin`, `computeAvailableOrderMargin`, transferable balances, available-to-trade for spot market and limit orders. |
| `orderBook.ts` | Walking the book: `matchBaseAmount` / `matchQuoteAmount`, worst execution price, available liquidity, slippage. |
| `matchInfo.ts` | Higher-level match results built on `orderBook.ts` — single-price, market-order, and combined match info. |
| `updatedStats.ts` | "What would my account look like after this order?" — position deltas, updated collateral, and the slider maxima (`computePerpsSliderMaxBaseAmount`, `computeSpotSliderMaxBaseAmount`). |
| `sltp.ts` | Stop-loss / take-profit derivation across the three input modes (trigger price, USD, percent). |
| `sltpTriggerValidation.ts` | Validating SL/TP triggers. Returns **i18n keys**, not sentences — see below. |
| `scale.ts` | Scale (ladder) orders: price and size distribution across N levels, average price. |
| `computeMaxIsolatedMarginWithdraw.ts` | Maximum removable margin from an isolated position. |
| `computeSpotMarketTvl.ts` | Spot market TVL. |
| `marginPercentageToFraction.ts` | One-liner used on the websocket transform path. |

## Conventions

- **`compute*` for math, `get*` for lookup and validation.**
- **Validation returns keys, not copy.** `getInvalidSLTPTriggerPriceKey` and
  friends return typed i18n keys (`InvalidSLTPTriggerPriceKey`,
  `SLTriggerPriceLiqWarningKey`) so the host owns wording and translation. Keep
  new validators to the same contract — no user-facing strings in this directory.
- **Nothing here throws for bad input.** Functions return `0`, `null`, or a
  validation key. Callers are rendering as the user types, mid-keystroke, and an
  exception per invalid intermediate state is not workable.
