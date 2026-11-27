import { persistence } from '../lib/persistence'
import type { GenerateClientOrderIndex } from '../lib/transactionConfig'
import { StrategyOrderKind } from '../types/StrategyOrderKind'

const LAST_MS_STORAGE_KEY = 'clientOrderIndexLastMs'
const KIND_MASK = 0b111
const TIMESTAMP_BITS = 45
const TWO_45 = 2 ** TIMESTAMP_BITS

let lastMs = 0

export function resetClientOrderIndexForTesting(): void {
  lastMs = 0
}

function loadPersistedMs(): void {
  try {
    const stored = Number(persistence.getItem(LAST_MS_STORAGE_KEY))
    if (Number.isSafeInteger(stored) && stored > lastMs) lastMs = stored
  } catch {}
}

/**
 * client_order_index = strategy kind (bits 45-47) | Unix ms (bits 0-44).
 * 45 bits of ms last until year ~3084. A ms that was already issued moves on to
 * the next one, and the last ms is persisted so a restart never re-issues it.
 */
export const generateTimestampClientOrderIndex: GenerateClientOrderIndex = (
  kind = StrategyOrderKind.None,
) => {
  loadPersistedMs()
  lastMs = Math.max(Date.now(), lastMs + 1)
  try {
    persistence.setItem(LAST_MS_STORAGE_KEY, String(lastMs))
  } catch {}
  return Promise.resolve((kind & KIND_MASK) * TWO_45 + lastMs)
}
