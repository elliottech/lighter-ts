export const ADVANCED_TWAP_PRESET = {
  /** Per-slice size jitter as a fraction (0.30 ≙ ±30%). */
  sizeJitter: 0.3,
  /** Per-interval timing jitter as a fraction (0.40 ≙ ±40%). */
  intervalJitter: 0.4,
  /** Default interval between slices (seconds). User-overridable. */
  defaultFrequencySec: 5,
  /** Upper bound for the wick-protection percentage (max % past index). */
  maxWickPercentage: 5,
} as const

export const LIMIT_CHASE_PRESET = {
  minMaxDistancePercent: 0,
  maxMaxDistancePercent: 5,
  /** 0 (an empty field) is valid: it bounds the order exactly at the index. */
  minMaxIndexPriceDistancePercent: 0,
  maxMaxIndexPriceDistancePercent: 5,
  /** Floor on the percent-unit chunk input. Chunks below the venue minimums
   *  are still allowed — the engine floors each slice at the venue minimum. */
  minRestingChunkPercent: 0.01,
  maxRestingChunkPercent: 100,
  /** How frequently the worker asks the venue to modify the working order. */
  defaultRepriceIntervalSec: 5,
} as const

export const ICEBERG_PRESET = {
  minRestingChunkPercent: 0.01,
  maxRestingChunkPercent: 33.33,
  /** How frequently the worker asks the venue to modify the working order. */
  defaultRepriceIntervalSec: 5,
  /** At what percentage of the resting chunk partial fill triggers a new order */
  newOrderRefillPercent: 0.1,
  maxRestingOrders: 10,
}

/**
 * Bounds for the user-configurable frequency input. The lower bound prevents
 * accidental flood orders; the upper bound keeps slice counts sane.
 */
export const MIN_FREQUENCY_SEC = 5
export const MAX_FREQUENCY_SEC = 3600

/**
 * Absolute ceiling on the number of child slices in a single TWAP. Without it
 * `sliceCount` is only bounded by duration/frequency — a 24h run at the 5s
 * minimum frequency would mint ~17k slices worth of child orders. When a
 * requested duration/frequency would exceed this, the validator keeps the
 * DURATION and widens the interval so the TWAP still spans the full window
 * with MAX_SLICE_COUNT orders.
 */
export const MAX_SLICE_COUNT = 5000

/**
 * Cap on simultaneously running strategies for Standard-tier accounts.
 */
export const STANDARD_MAX_CONCURRENT_STRATEGIES = 3

/**
 * Cap on simultaneously running strategies for Plus and Premium accounts.
 * Each running strategy holds a live engine (timers + in-memory schedule), a
 * worker entry, and an order-RPC stream, and terminal-record pruning
 * intentionally never evicts running ones — so without this nothing bounds how
 * many can accumulate at once.
 */
export const MAX_CONCURRENT_STRATEGIES = 10

export const STRATEGY_PLUS_TIER_REQUIRED = 'strategy_plus_tier_required'

/**
 * Minimum runtime accepted by the randomize path (1 minute), versus native
 * TWAP's 5-min floor. Anything outside this range is rejected at submit time.
 */
export const MIN_RUNTIME_SEC = 60

/**
 * Maximum runtime for the Advanced TWAP (native TWAP still allows 30 days).
 */
export const MAX_RUNTIME_HOURS = 24

/**
 * Per-slice slippage tolerance (percent) for the protective price bound on each
 * child market order. We mirror the backend's per-order slippage (3%) rather
 * than the user's UI slippage preference. Note: native TWAP applies 100%
 * slippage to the *whole* parent order; here each individual child slice is
 * bounded at 3% instead, from both the book and the index price.
 */
export const PER_SLICE_SLIPPAGE_PCT = 3

/**
 * Backstop in the worker's order client, independent of any engine: an order
 * priced more than this far past the index (mark when there is no index) on
 * the side that costs the user is refused and the strategy aborts. Looser
 * than PER_SLICE_SLIPPAGE_PCT so it only trips on an engine bug.
 */
export const ORDER_PRICE_GUARD_PCT = 10

/** Format a 0..1 fraction as a "±N%" string for UI explainers. */
export const formatJitterPct = (fraction: number): string => `±${Math.round(fraction * 100)}%`
